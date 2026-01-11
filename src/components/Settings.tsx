import { Command } from '@tauri-apps/plugin-shell';
import { vaultService } from '../services/vault';
import './Settings.css';

interface SettingsProps {
  onClose: () => void;
  memoryFilePath: string | null;
}

export function Settings({ onClose, memoryFilePath }: SettingsProps) {
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

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button onClick={onClose} className="close-button">×</button>
        </div>

        <div className="settings-content">
          <div className="settings-section">
            <h3>Memory</h3>
            <p className="settings-description">
              Your memory file stores context and preferences that are included with every conversation.
            </p>
            <button
              onClick={handleRevealMemory}
              className="reveal-button"
            >
              Reveal memory.md in Finder
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
