import React from 'react';
import { ModelInfo, getProviderFromModel } from '../types';
import { PROVIDER_NAMES } from '../utils/models';

interface ModelDropdownItemProps {
  model: ModelInfo;
  className?: string;
}

export const ModelDropdownItem: React.FC<ModelDropdownItemProps> = ({
  model,
  className = 'comparison-model-item',
}) => {
  const provider = getProviderFromModel(model.key);

  return (
    <div className={className}>
      <span className={`${className.replace('-item', '-model-name')}`}>{model.name}</span>
      <span className={`${className.replace('-item', '-model-provider')} provider-${provider}`}>
        {PROVIDER_NAMES[provider]}
      </span>
    </div>
  );
};
