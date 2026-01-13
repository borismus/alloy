import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { vaultService } from '../services/vault';
import './Settings.css';

interface SettingsProps {
  onClose: () => void;
  memoryFilePath: string | null;
  vaultPath: string | null;
  onChangeVault: () => Promise<void>;
  onConfigReload?: () => Promise<void>;
}

export function Settings({ onClose, memoryFilePath, vaultPath, onChangeVault, onConfigReload: _onConfigReload }: SettingsProps) {
  const handleRevealVaultInFinder = async () => {
    try {
      if (!vaultPath) {
        console.error('Vault path not found');
        return;
      }
      await revealItemInDir(vaultPath);
    } catch (error) {
      console.error('Failed to reveal vault in Finder:', error);
    }
  };

  const handleEditMemory = async () => {
    try {
      const filePath = memoryFilePath || await vaultService.getMemoryFilePath();

      if (!filePath) {
        console.error('Memory file path not found');
        return;
      }

      await openPath(filePath);
    } catch (error) {
      console.error('Failed to open memory file:', error);
    }
  };

  const handleEditConfig = async () => {
    try {
      const filePath = await vaultService.getConfigFilePath();

      if (!filePath) {
        console.error('Config file path not found');
        return;
      }

      await openPath(filePath);
    } catch (error) {
      console.error('Failed to open config file:', error);
    }
  };

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button onClick={onClose} className="close-button">×</button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>Vault</h3>
            <p className="settings-description">
              Your vault stores all conversations and settings. Point it to a synced folder (like Obsidian) to sync across devices.
            </p>
            {vaultPath && (
              <p className="vault-path">{vaultPath}</p>
            )}
            <div className="settings-button-group">
              <button
                onClick={onChangeVault}
                className="settings-button"
              >
                Change Vault Location
              </button>
              <button
                onClick={handleRevealVaultInFinder}
                className="settings-button"
              >
                Reveal in Finder
              </button>
            </div>
          </div>

          <div className="settings-section">
            <h3>Memory</h3>
            <p className="settings-description">
              Your memory file stores context and preferences that are included with every conversation.
            </p>
            <button
              onClick={handleEditMemory}
              className="settings-button"
            >
              Edit memory.md
            </button>
          </div>

          <div className="settings-section">
            <h3>Configuration</h3>
            <p className="settings-description">
              Your config file stores API keys and other settings. Edit it to add or change providers.
            </p>
            <button
              onClick={handleEditConfig}
              className="settings-button"
            >
              Edit config.yaml
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
