'use client';

import React, { useState } from 'react';
import { ModelSelector } from './ModelSelector';
import { SovereignModel, SOVEREIGN_MODEL_CATALOG } from '../types/models';

export const StudioHeader: React.FC = () => {
  const [currentModel, setCurrentModel] = useState<SovereignModel>(SOVEREIGN_MODEL_CATALOG[0]);

  return (
    <header className="h-16 border-b border-neutral-800 bg-neutral-950 px-6 flex items-center justify-between">
      <div className="flex items-center space-x-4">
        <div className="flex items-center space-x-2">
          <div className="w-8 h-8 rounded bg-gradient-to-tr from-cyan-600 via-indigo-600 to-purple-600 flex items-center justify-center font-bold text-white shadow-lg">
            MA
          </div>
          <div>
            <span className="font-bold text-base text-white tracking-wide">MINDARCHITECT</span>
            <span className="text-xs text-neutral-400 ml-1.5 font-light">STUDIO</span>
          </div>
        </div>
        <span className="text-neutral-700">|</span>
        <div className="text-xs font-mono text-neutral-400">
          Powered by <span className="text-cyan-400 font-semibold">HussnainTechVertex Pvt Ltd</span>
        </div>
      </div>

      <div className="flex items-center space-x-4">
        <ModelSelector
          selectedModelId={currentModel.model_id}
          onSelectModel={(model) => setCurrentModel(model)}
        />
        <div className="flex items-center space-x-2 text-xs text-neutral-400 bg-neutral-900 px-3 py-1.5 rounded-md border border-neutral-800 font-mono">
          <span>Active Context:</span>
          <span className="text-white font-bold">{currentModel.context_window.toLocaleString()} tokens</span>
        </div>
      </div>
    </header>
  );
};
