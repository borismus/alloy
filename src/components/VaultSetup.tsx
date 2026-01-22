import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { vaultService } from '../services/vault';
import { ProviderType } from '../types';
import './VaultSetup.css';

interface VaultSetupProps {
  onVaultSelected: (path: string, provider: ProviderType, credential: string) => void;
  onExistingVault: (path: string) => void;
}

type Step = 'vault' | 'provider' | 'credential';

export function VaultSetup({ onVaultSelected, onExistingVault }: VaultSetupProps) {
  const [step, setStep] = useState<Step>('vault');
  const [isSelecting, setIsSelecting] = useState(false);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderType | null>(null);
  const [credential, setCredential] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSelectFolder = async () => {
    setIsSelecting(true);
    try {
      const path = await vaultService.selectVaultFolder();
      if (path) {
        // Check if config already has a provider configured
        const config = await vaultService.loadConfig();
        if (config && (config.ANTHROPIC_API_KEY || config.OPENAI_API_KEY || config.OLLAMA_BASE_URL)) {
          // Vault already has a provider - skip wizard
          onExistingVault(path);
          return;
        }

        setVaultPath(path);
        setStep('provider');
      }
    } catch (error) {
      console.error('Error selecting vault folder:', error);
      alert('Error selecting folder. Please try again.');
    } finally {
      setIsSelecting(false);
    }
  };

  const handleProviderSelect = (provider: ProviderType) => {
    setSelectedProvider(provider);
    setCredential(provider === 'ollama' ? 'http://localhost:11434' : '');
    setStep('credential');
  };

  const handleComplete = async () => {
    if (!vaultPath || !selectedProvider || !credential.trim()) return;

    setIsSubmitting(true);
    try {
      onVaultSelected(vaultPath, selectedProvider, credential.trim());
    } catch (error) {
      console.error('Error completing setup:', error);
      alert('Error completing setup. Please try again.');
      setIsSubmitting(false);
    }
  };

  const getPlaceholder = () => {
    switch (selectedProvider) {
      case 'anthropic':
        return 'sk-ant-...';
      case 'openai':
        return 'sk-...';
      case 'ollama':
        return 'http://localhost:11434';
      default:
        return '';
    }
  };

  const getCredentialLabel = () => {
    switch (selectedProvider) {
      case 'anthropic':
        return 'Anthropic API Key';
      case 'openai':
        return 'OpenAI API Key';
      case 'ollama':
        return 'Ollama Base URL';
      default:
        return 'Credential';
    }
  };

  return (
    <div className="vault-setup">
      <div className="vault-setup-content">
        {step === 'vault' && (
          <>
            <h1>Welcome to Orchestra</h1>
            <p>Conduct your AI</p>

            <div className="vault-setup-description">
              <p>
                Orchestra stores all your conversations as plain text files in a folder
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
          </>
        )}

        {step === 'provider' && (
          <>
            <h1>Choose a Provider</h1>
            <p>Select an AI provider to get started</p>

            <div className="provider-cards">
              <button
                className="provider-card"
                onClick={() => handleProviderSelect('anthropic')}
              >
                <div className="provider-name">Anthropic</div>
                <div className="provider-description">
                  Claude models including Opus, Sonnet, and Haiku
                </div>
              </button>

              <button
                className="provider-card"
                onClick={() => handleProviderSelect('openai')}
              >
                <div className="provider-name">OpenAI</div>
                <div className="provider-description">
                  GPT-4o, GPT-4 Turbo, o1, and more
                </div>
              </button>

              <button
                className="provider-card"
                onClick={() => handleProviderSelect('ollama')}
              >
                <div className="provider-name">Ollama</div>
                <div className="provider-description">
                  Run models locally - no API key needed
                </div>
              </button>
            </div>

            <div className="vault-setup-footer">
              <small>You can add more providers later in Settings</small>
            </div>
          </>
        )}

        {step === 'credential' && selectedProvider && (
          <>
            <h1>Configure {selectedProvider === 'anthropic' ? 'Anthropic' : selectedProvider === 'openai' ? 'OpenAI' : 'Ollama'}</h1>
            <p>Enter your {selectedProvider === 'ollama' ? 'Ollama server URL' : 'API key'}</p>

            <div className="credential-form">
              <label htmlFor="credential">{getCredentialLabel()}</label>
              <input
                id="credential"
                type={selectedProvider === 'ollama' ? 'text' : 'password'}
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={getPlaceholder()}
                className="credential-input"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />

              {selectedProvider !== 'ollama' && (
                <div className="credential-help">
                  {selectedProvider === 'anthropic' && (
                    <a href="#" onClick={(e) => { e.preventDefault(); openUrl('https://console.anthropic.com/settings/keys'); }}>
                      Get your API key from Anthropic Console
                    </a>
                  )}
                  {selectedProvider === 'openai' && (
                    <a href="#" onClick={(e) => { e.preventDefault(); openUrl('https://platform.openai.com/api-keys'); }}>
                      Get your API key from OpenAI Platform
                    </a>
                  )}
                </div>
              )}
            </div>

            <div className="setup-actions">
              <button
                onClick={() => setStep('provider')}
                className="back-button"
              >
                Back
              </button>
              <button
                onClick={handleComplete}
                disabled={!credential.trim() || isSubmitting}
                className="select-vault-button"
              >
                {isSubmitting ? 'Setting up...' : 'Get Started'}
              </button>
            </div>

            <div className="vault-setup-footer">
              <small>Your credentials are stored locally in your vault's config.yaml</small>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
