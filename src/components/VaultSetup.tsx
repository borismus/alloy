import { useState } from 'react';
import { vaultService } from '../services/vault';
import './VaultSetup.css';

interface VaultSetupProps {
  onVaultSelected: (path: string) => void;
}

export function VaultSetup({ onVaultSelected }: VaultSetupProps) {
  const [isSelecting, setIsSelecting] = useState(false);

  const handleSelectFolder = async () => {
    setIsSelecting(true);
    try {
      const path = await vaultService.selectVaultFolder();
      if (path) {
        onVaultSelected(path);
      }
    } catch (error) {
      console.error('Error selecting vault folder:', error);
      alert('Error selecting folder. Please try again.');
    } finally {
      setIsSelecting(false);
    }
  };

  return (
    <div className="vault-setup">
      <div className="vault-setup-content">
        <h1>Welcome to PromptBox</h1>
        <p>Own your AI conversations</p>

        <div className="vault-setup-description">
          <p>
            PromptBox stores all your conversations as plain text files in a folder
            you choose. This folder is called your "vault".
          </p>
          <p>
            You can sync it, back it up, and read it with any text editor.
            Your data, your control.
          </p>
        </div>

        <button
          onClick={handleSelectFolder}
          disabled={isSelecting}
          className="select-vault-button"
        >
          {isSelecting ? 'Selecting...' : 'Select Vault Folder'}
        </button>

        <div className="vault-setup-footer">
          <small>No analytics. No cloud dependency. Just your files.</small>
        </div>
      </div>
    </div>
  );
}
