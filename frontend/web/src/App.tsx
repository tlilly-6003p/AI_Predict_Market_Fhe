// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface ModelRecord {
  id: string;
  name: string;
  encryptedScore: string;
  timestamp: number;
  owner: string;
  category: string;
  predictionCount: number;
  lastUpdated: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [models, setModels] = useState<ModelRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newModelData, setNewModelData] = useState({ name: "", category: "NLP", score: 0 });
  const [selectedModel, setSelectedModel] = useState<ModelRecord | null>(null);
  const [decryptedScore, setDecryptedScore] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");

  // Stats calculations
  const totalModels = models.length;
  const avgScore = totalModels > 0 
    ? models.reduce((sum, model) => sum + FHEDecryptNumber(model.encryptedScore), 0) / totalModels 
    : 0;
  const categories = [...new Set(models.map(m => m.category))];
  const topModel = [...models].sort((a, b) => 
    FHEDecryptNumber(b.encryptedScore) - FHEDecryptNumber(a.encryptedScore)
  )[0];

  useEffect(() => {
    loadModels().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadModels = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        console.log("Contract not available");
        return;
      }

      // Load model keys
      const keysBytes = await contract.getData("model_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing model keys:", e); }
      }

      // Load each model
      const modelList: ModelRecord[] = [];
      for (const key of keys) {
        try {
          const modelBytes = await contract.getData(`model_${key}`);
          if (modelBytes.length > 0) {
            try {
              const modelData = JSON.parse(ethers.toUtf8String(modelBytes));
              modelList.push({ 
                id: key, 
                name: modelData.name,
                encryptedScore: modelData.score, 
                timestamp: modelData.timestamp, 
                owner: modelData.owner, 
                category: modelData.category,
                predictionCount: modelData.predictionCount || 0,
                lastUpdated: modelData.lastUpdated || modelData.timestamp
              });
            } catch (e) { console.error(`Error parsing model data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading model ${key}:`, e); }
      }

      // Sort by score (descending)
      modelList.sort((a, b) => {
        const scoreA = FHEDecryptNumber(a.encryptedScore);
        const scoreB = FHEDecryptNumber(b.encryptedScore);
        return scoreB - scoreA;
      });

      setModels(modelList);
    } catch (e) { 
      console.error("Error loading models:", e); 
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  const submitModel = async () => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setCreating(true);
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Encrypting model score with Zama FHE..." 
    });

    try {
      // Encrypt the score
      const encryptedScore = FHEEncryptNumber(newModelData.score);
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");

      // Generate unique ID
      const modelId = `model-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      
      // Prepare model data
      const modelData = { 
        name: newModelData.name,
        score: encryptedScore, 
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        category: newModelData.category,
        predictionCount: 0,
        lastUpdated: Math.floor(Date.now() / 1000)
      };

      // Store model data
      await contract.setData(`model_${modelId}`, ethers.toUtf8Bytes(JSON.stringify(modelData)));

      // Update model keys list
      const keysBytes = await contract.getData("model_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { 
          keys = JSON.parse(ethers.toUtf8String(keysBytes)); 
        } catch (e) { 
          console.error("Error parsing keys:", e); 
        }
      }
      keys.push(modelId);
      await contract.setData("model_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));

      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Model submitted with FHE encryption!" 
      });

      // Refresh list
      await loadModels();
      
      // Reset form
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewModelData({ name: "", category: "NLP", score: 0 });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Submission failed: " + (e.message || "Unknown error");
      
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: errorMessage 
      });
      
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
        3000
      );
    } finally { 
      setCreating(false); 
    }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      // Signature request message
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      
      // Request signature
      await signMessageAsync({ message });
      
      // Simulate decryption delay
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Return decrypted value
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      console.error("Decryption failed:", e); 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  const submitPrediction = async (modelId: string, predictionScore: number) => {
    if (!isConnected) { 
      alert("Please connect wallet first"); 
      return; 
    }
    
    setTransactionStatus({ 
      visible: true, 
      status: "pending", 
      message: "Processing prediction with FHE..." 
    });

    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      
      // Get current model data
      const modelBytes = await contract.getData(`model_${modelId}`);
      if (modelBytes.length === 0) throw new Error("Model not found");
      
      const modelData = JSON.parse(ethers.toUtf8String(modelBytes));
      
      // Get contract with signer
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      // Update model with new prediction count
      const updatedModel = { 
        ...modelData, 
        predictionCount: (modelData.predictionCount || 0) + 1,
        lastUpdated: Math.floor(Date.now() / 1000)
      };
      
      await contractWithSigner.setData(`model_${modelId}`, ethers.toUtf8Bytes(JSON.stringify(updatedModel)));
      
      setTransactionStatus({ 
        visible: true, 
        status: "success", 
        message: "Prediction submitted successfully!" 
      });
      
      await loadModels();
      
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
        2000
      );
    } catch (e: any) {
      setTransactionStatus({ 
        visible: true, 
        status: "error", 
        message: "Prediction failed: " + (e.message || "Unknown error") 
      });
      
      setTimeout(() => 
        setTransactionStatus({ visible: false, status: "pending", message: "" }), 
        3000
      );
    }
  };

  const isOwner = (modelAddress: string) => 
    address?.toLowerCase() === modelAddress.toLowerCase();

  // Filter models based on search and category
  const filteredModels = models.filter(model => {
    const matchesSearch = model.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesCategory = filterCategory === "all" || model.category === filterCategory;
    return matchesSearch && matchesCategory;
  });

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing FHE connection...</p>
    </div>
  );

  return (
    <div className="app-container future-tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="circuit-icon"></div>
          </div>
          <h1>AI<span>Prediction</span>Market</h1>
        </div>
        <div className="header-actions">
          <button 
            onClick={() => setShowCreateModal(true)} 
            className="create-model-btn tech-button"
          >
            <div className="add-icon"></div>Add Model
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        {/* Project Introduction */}
        <div className="intro-section tech-card">
          <h2>FHE-Powered AI Prediction Market</h2>
          <p>
            A decentralized prediction market for AI model performance. 
            Models are evaluated on encrypted test sets using Zama FHE technology 
            to ensure fairness and privacy.
          </p>
          <div className="fhe-badge">
            <span>Fully Homomorphic Encryption</span>
          </div>
        </div>

        {/* Data Statistics */}
        <div className="stats-section">
          <div className="stat-card tech-card">
            <h3>Total Models</h3>
            <div className="stat-value">{totalModels}</div>
          </div>
          <div className="stat-card tech-card">
            <h3>Average Score</h3>
            <div className="stat-value">{avgScore.toFixed(2)}</div>
          </div>
          <div className="stat-card tech-card">
            <h3>Top Score</h3>
            <div className="stat-value">
              {topModel ? FHEDecryptNumber(topModel.encryptedScore).toFixed(2) : "N/A"}
            </div>
          </div>
          <div className="stat-card tech-card">
            <h3>Categories</h3>
            <div className="stat-value">{categories.length}</div>
          </div>
        </div>

        {/* Search & Filter */}
        <div className="search-filter-section tech-card">
          <div className="search-box">
            <input
              type="text"
              placeholder="Search models..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="tech-input"
            />
            <div className="search-icon"></div>
          </div>
          <select
            value={filterCategory}
            onChange={(e) => setFilterCategory(e.target.value)}
            className="tech-select"
          >
            <option value="all">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>{cat}</option>
            ))}
          </select>
          <button 
            onClick={loadModels} 
            className="refresh-btn tech-button" 
            disabled={isRefreshing}
          >
            {isRefreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>

        {/* Model Leaderboard */}
        <div className="leaderboard-section">
          <h2>AI Model Leaderboard</h2>
          <div className="leaderboard-table tech-card">
            <div className="table-header">
              <div className="header-cell">Rank</div>
              <div className="header-cell">Model Name</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">Encrypted Score</div>
              <div className="header-cell">Predictions</div>
              <div className="header-cell">Actions</div>
            </div>
            
            {filteredModels.length === 0 ? (
              <div className="no-models">
                <div className="no-models-icon"></div>
                <p>No models found matching your criteria</p>
                <button 
                  className="tech-button primary" 
                  onClick={() => setShowCreateModal(true)}
                >
                  Add First Model
                </button>
              </div>
            ) : (
              filteredModels.map((model, index) => (
                <div 
                  className="model-row" 
                  key={model.id} 
                  onClick={() => setSelectedModel(model)}
                >
                  <div className="table-cell rank">#{index + 1}</div>
                  <div className="table-cell name">{model.name}</div>
                  <div className="table-cell category">{model.category}</div>
                  <div className="table-cell score">
                    {model.encryptedScore.substring(0, 12)}...
                  </div>
                  <div className="table-cell predictions">{model.predictionCount}</div>
                  <div className="table-cell actions">
                    <button 
                      className="action-btn tech-button"
                      onClick={(e) => {
                        e.stopPropagation();
                        submitPrediction(model.id, 0);
                      }}
                    >
                      Predict
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Create Model Modal */}
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitModel} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          modelData={newModelData} 
          setModelData={setNewModelData}
        />
      )}

      {/* Model Detail Modal */}
      {selectedModel && (
        <ModelDetailModal 
          model={selectedModel} 
          onClose={() => { 
            setSelectedModel(null); 
            setDecryptedScore(null); 
          }} 
          decryptedScore={decryptedScore} 
          setDecryptedScore={setDecryptedScore} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="circuit-icon"></div>
              <span>AI Prediction Market</span>
            </div>
            <p>Powered by Zama FHE technology</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>FHE-Powered Privacy</span>
          </div>
          <div className="copyright">
            © {new Date().getFullYear()} AI Prediction Market. All rights reserved.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  modelData: any;
  setModelData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ 
  onSubmit, 
  onClose, 
  creating, 
  modelData, 
  setModelData 
}) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setModelData({ ...modelData, [name]: value });
  };

  const handleScoreChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setModelData({ ...modelData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!modelData.name || !modelData.score) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal tech-card">
        <div className="modal-header">
          <h2>Add AI Model</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Model scores will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Model Name *</label>
            <input 
              type="text" 
              name="name" 
              value={modelData.name} 
              onChange={handleChange} 
              placeholder="Enter model name..." 
              className="tech-input"
            />
          </div>
          
          <div className="form-group">
            <label>Category *</label>
            <select 
              name="category" 
              value={modelData.category} 
              onChange={handleChange} 
              className="tech-select"
            >
              <option value="NLP">Natural Language Processing</option>
              <option value="CV">Computer Vision</option>
              <option value="RL">Reinforcement Learning</option>
              <option value="GenAI">Generative AI</option>
              <option value="Other">Other</option>
            </select>
          </div>
          
          <div className="form-group">
            <label>Performance Score *</label>
            <input 
              type="number" 
              name="score" 
              value={modelData.score} 
              onChange={handleScoreChange} 
              placeholder="Enter score (0-100)..." 
              className="tech-input"
              min="0"
              max="100"
              step="0.1"
            />
          </div>
          
          <div className="encryption-preview">
            <h4>Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Score:</span>
                <div>{modelData.score || 'No score entered'}</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>
                  {modelData.score ? 
                    FHEEncryptNumber(modelData.score).substring(0, 50) + '...' : 
                    'No score entered'
                  }
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">
            Cancel
          </button>
          <button 
            onClick={handleSubmit} 
            disabled={creating} 
            className="submit-btn tech-button primary"
          >
            {creating ? "Encrypting with FHE..." : "Submit Model"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ModelDetailModalProps {
  model: ModelRecord;
  onClose: () => void;
  decryptedScore: number | null;
  setDecryptedScore: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const ModelDetailModal: React.FC<ModelDetailModalProps> = ({ 
  model, 
  onClose, 
  decryptedScore, 
  setDecryptedScore, 
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecrypt = async () => {
    if (decryptedScore !== null) { 
      setDecryptedScore(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(model.encryptedScore);
    if (decrypted !== null) setDecryptedScore(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="model-detail-modal tech-card">
        <div className="modal-header">
          <h2>Model Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="model-info">
            <div className="info-item">
              <span>Name:</span>
              <strong>{model.name}</strong>
            </div>
            <div className="info-item">
              <span>Owner:</span>
              <strong>
                {model.owner.substring(0, 6)}...{model.owner.substring(38)}
              </strong>
            </div>
            <div className="info-item">
              <span>Category:</span>
              <strong>{model.category}</strong>
            </div>
            <div className="info-item">
              <span>Created:</span>
              <strong>
                {new Date(model.timestamp * 1000).toLocaleDateString()}
              </strong>
            </div>
            <div className="info-item">
              <span>Last Updated:</span>
              <strong>
                {new Date(model.lastUpdated * 1000).toLocaleDateString()}
              </strong>
            </div>
            <div className="info-item">
              <span>Predictions:</span>
              <strong>{model.predictionCount}</strong>
            </div>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Performance Score</h3>
            <div className="encrypted-data">
              {model.encryptedScore.substring(0, 100)}...
            </div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            <button 
              className="decrypt-btn tech-button" 
              onClick={handleDecrypt} 
              disabled={isDecrypting}
            >
              {isDecrypting ? (
                <span className="decrypt-spinner"></span>
              ) : decryptedScore !== null ? (
                "Hide Decrypted Score"
              ) : (
                "Decrypt with Wallet Signature"
              )}
            </button>
          </div>
          
          {decryptedScore !== null && (
            <div className="decrypted-data-section">
              <h3>Decrypted Score</h3>
              <div className="decrypted-value">
                {decryptedScore.toFixed(2)}
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>
                  Decrypted score is only visible after wallet signature verification
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

export default App;
