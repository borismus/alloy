import { Command } from '@tauri-apps/plugin-shell';
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
  const handleRevealMemory = async () => {
    try {
      // Get the memory file path if not already available
      const filePath = memoryFilePath || await vaultService.getMemoryFilePath();

      if (!filePath) {
        console.error('Memory file path not found');
        return;
      }

      await Command.create('open', ['-R', filePath]).execute();
    } catch (error) {
      console.error('Failed to reveal memory file:', error);
    }
  };

  const handleRevealConfig = async () => {
    try {
      const filePath = await vaultService.getConfigFilePath();

      if (!filePath) {
        console.error('Config file path not found');
        return;
      }

      await Command.create('open', ['-R', filePath]).execute();
    } catch (error) {
      console.error('Failed to reveal config file:', error);
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
            <button
              onClick={onChangeVault}
              className="settings-button"
            >
              Change Vault Location
            </button>
          </div>

          <div className="settings-section">
            <h3>Memory</h3>
            <p className="settings-description">
              Your memory file stores context and preferences that are included with every conversation.
            </p>
            <button
              onClick={handleRevealMemory}
              className="settings-button"
            >
              Reveal memory.md in Finder
            </button>
          </div>

          <div className="settings-section">
            <h3>Configuration</h3>
            <p className="settings-description">
              Your config file stores API keys and other settings. Edit it to add or change providers.
            </p>
            <button
              onClick={handleRevealConfig}
              className="settings-button"
            >
              Reveal config.yaml in Finder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
