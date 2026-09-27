'use client';

import React, { useState } from 'react';
import { SovereignModel, SOVEREIGN_MODEL_CATALOG, ModelSeries } from '../types/models';

interface ModelSelectorProps {
  selectedModelId: string;
  onSelectModel: (model: SovereignModel) => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ selectedModelId, onSelectModel }) => {
  const [isOpen, setIsOpen] = useState(false);
  const selectedModel = SOVEREIGN_MODEL_CATALOG.find((m) => m.model_id === selectedModelId) || SOVEREIGN_MODEL_CATALOG[0];

  const getSeriesBadge = (series: ModelSeries) => {
    switch (series) {
      case 'V-Series':
        return <span className="px-2 py-0.5 text-xs font-semibold rounded bg-cyan-950 text-cyan-400 border border-cyan-700">V-Series</span>;
      case 'M-Series':
        return <span className="px-2 py-0.5 text-xs font-semibold rounded bg-purple-950 text-purple-400 border border-purple-700">M-Series</span>;
      case 'Specialized':
        return <span className="px-2 py-0.5 text-xs font-semibold rounded bg-emerald-950 text-emerald-400 border border-emerald-700">Specialist</span>;
      case 'Development':
        return <span className="px-2 py-0.5 text-xs font-semibold rounded bg-amber-950 text-amber-400 border border-amber-700">Dev Only</span>;
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'ACTIVE':
        return <span className="flex items-center text-xs text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse"></span>Live</span>;
      case 'CHECKPOINT_REQUIRED':
        return <span className="flex items-center text-xs text-blue-400"><span className="w-1.5 h-1.5 rounded-full bg-blue-400 mr-1.5"></span>A6000 Ready</span>;
      case 'DEVELOPMENT_ONLY':
        return <span className="flex items-center text-xs text-amber-400"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 mr-1.5"></span>Host Verified</span>;
      default:
        return null;
    }
  };

  return (
    <div className="relative inline-block text-left w-80">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 bg-neutral-900 border border-neutral-700 rounded-lg hover:border-neutral-500 transition-colors focus:outline-none focus:ring-1 focus:ring-cyan-500"
      >
        <div className="flex flex-col text-left truncate mr-2">
          <div className="flex items-center space-x-2">
            <span className="text-sm font-medium text-white truncate">{selectedModel.display_name}</span>
            {getSeriesBadge(selectedModel.series)}
          </div>
          <span className="text-xs text-neutral-400 truncate">Counter: {selectedModel.competitor_target}</span>
        </div>
        <div className="flex items-center space-x-2">
          {getStatusBadge(selectedModel.status)}
          <svg className={`w-4 h-4 text-neutral-400 transition-transform ${isOpen ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {isOpen && (
        <div className="absolute right-0 mt-2 w-96 origin-top-right rounded-lg bg-neutral-900 border border-neutral-700 shadow-2xl z-50 overflow-hidden divide-y divide-neutral-800">
          <div className="p-3 bg-neutral-950">
            <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">HussnainTechVertex Sovereign Hierarchy</div>
            <div className="text-[11px] text-neutral-500">Autonomous cognitive & architectural dominance engines</div>
          </div>
          <div className="max-h-96 overflow-y-auto p-1.5 space-y-1">
            {SOVEREIGN_MODEL_CATALOG.map((model) => (
              <button
                key={model.model_id}
                onClick={() => {
                  onSelectModel(model);
                  setIsOpen(false);
                }}
                className={`w-full text-left p-2.5 rounded-md transition-all flex flex-col space-y-1 ${
                  selectedModel.model_id === model.model_id ? 'bg-neutral-800 border border-cyan-800/60' : 'hover:bg-neutral-800/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-2">
                    <span className="text-sm font-semibold text-white">{model.display_name}</span>
                    {getSeriesBadge(model.series)}
                  </div>
                  {getStatusBadge(model.status)}
                </div>
                <div className="text-xs text-cyan-400/90 font-mono flex items-center space-x-2">
                  <span>Target: {model.competitor_target}</span>
                  <span>•</span>
                  <span>{model.parameter_scale}</span>
                </div>
                <p className="text-xs text-neutral-400 line-clamp-2 leading-relaxed">{model.specialization}</p>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
