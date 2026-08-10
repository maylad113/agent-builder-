import React, { useState } from 'react';
import { Agent, ToneType, BehaviorType, LanguageType } from '../types';
import { 
  Bot, 
  Sparkles, 
  Save, 
  CheckCircle2, 
  AlertCircle, 
  Play, 
  Pause, 
  History, 
  ShieldAlert, 
  Sliders, 
  Wrench 
} from 'lucide-react';

interface AgentBuilderProps {
  agent: Agent;
  onUpdateAgent: (updatedAgent: Partial<Agent>) => void;
  onToggleStatus: (status: 'DRAFT' | 'TESTING' | 'READY' | 'ACTIVE' | 'PAUSED') => void;
}

export const AgentBuilder: React.FC<AgentBuilderProps> = ({
  agent,
  onUpdateAgent,
  onToggleStatus
}) => {
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description);
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt);
  
  const [tone, setTone] = useState<ToneType>(agent.structuredConfig?.personality?.tone || 'friendly');
  const [behavior, setBehavior] = useState<BehaviorType>(agent.structuredConfig?.personality?.behavior || 'service');
  const [language, setLanguage] = useState<LanguageType>(agent.structuredConfig?.personality?.language || 'en');
  const [customPrompt, setCustomPrompt] = useState(agent.structuredConfig?.personality?.customPrompt || '');

  const [allowedActionsText, setAllowedActionsText] = useState((agent.structuredConfig?.allowedActions || []).join('\n'));
  const [restrictedActionsText, setRestrictedActionsText] = useState((agent.structuredConfig?.restrictedActions || []).join('\n'));
  const [escalationRulesText, setEscalationRulesText] = useState((agent.structuredConfig?.escalationRules || []).join('\n'));

  const [savedSuccess, setSavedSuccess] = useState(false);

  const handleSave = () => {
    const updatedStructured = {
      ...agent.structuredConfig,
      personality: {
        tone,
        behavior,
        language,
        customPrompt
      },
      allowedActions: allowedActionsText.split('\n').filter(Boolean),
      restrictedActions: restrictedActionsText.split('\n').filter(Boolean),
      escalationRules: escalationRulesText.split('\n').filter(Boolean)
    };

    onUpdateAgent({
      name,
      description,
      systemPrompt,
      structuredConfig: updatedStructured
    });

    setSavedSuccess(true);
    setTimeout(() => setSavedSuccess(false), 3000);
  };

  return (
    <div className="space-y-6">
      
      {/* Top Header Card */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <Bot className="w-5 h-5 text-blue-600" />
            <h2 className="text-xl font-bold text-slate-900">{agent.name}</h2>
            <span className="text-xs px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700 font-semibold border border-slate-200">
              v{agent.version}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-1">{agent.description}</p>
        </div>

        {/* State Toggle Buttons */}
        <div className="flex items-center space-x-3">
          <span className={`px-3 py-1 text-xs font-bold rounded-full uppercase tracking-wider ${
            agent.status === 'ACTIVE' 
              ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' 
              : 'bg-amber-100 text-amber-800 border border-amber-300'
          }`}>
            {agent.status}
          </span>

          {agent.status === 'ACTIVE' ? (
            <button
              onClick={() => onToggleStatus('PAUSED')}
              className="flex items-center space-x-1.5 bg-amber-600 hover:bg-amber-500 text-white px-3.5 py-1.5 rounded-xl text-xs font-semibold shadow-sm"
            >
              <Pause className="w-3.5 h-3.5" />
              <span>Pause Agent</span>
            </button>
          ) : (
            <button
              onClick={() => onToggleStatus('ACTIVE')}
              className="flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-500 text-white px-3.5 py-1.5 rounded-xl text-xs font-semibold shadow-sm"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Deploy to Active</span>
            </button>
          )}

          <button
            onClick={handleSave}
            className="flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-500 text-white px-4 py-1.5 rounded-xl text-xs font-semibold shadow-sm transition-all"
          >
            <Save className="w-3.5 h-3.5" />
            <span>Save Version</span>
          </button>
        </div>
      </div>

      {savedSuccess && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-semibold text-emerald-800 flex items-center space-x-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <span>Agent updated successfully! Increment version to v{agent.version + 1}.</span>
        </div>
      )}

      {/* Main Grid: Structured Config & System Instructions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Left Column: Personality & Rules */}
        <div className="space-y-6">
          
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4">
            <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2">
              <Sliders className="w-4 h-4 text-blue-600" />
              <span>Personality & Tone Settings</span>
            </h3>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Tone</label>
              <select
                value={tone}
                onChange={(e) => setTone(e.target.value as ToneType)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:outline-none"
              >
                <option value="friendly">Friendly & Welcoming</option>
                <option value="professional">Professional & Formal</option>
                <option value="casual">Casual & Conversational</option>
                <option value="concise">Concise & Direct</option>
                <option value="luxury">Luxury & Premium</option>
                <option value="energetic">Energetic & Enthusiastic</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Primary Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as LanguageType)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs font-medium text-slate-800 focus:outline-none"
              >
                <option value="en">English</option>
                <option value="fa">Persian (Farsi)</option>
                <option value="bilingual">Bilingual (English / Persian)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Custom Style Instruction</label>
              <input
                type="text"
                placeholder="e.g. Always end with a polite invitation to visit the shop"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 focus:outline-none"
              />
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4">
            <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2">
              <ShieldAlert className="w-4 h-4 text-amber-600" />
              <span>Allowed & Restricted Actions</span>
            </h3>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Allowed Capabilities</label>
              <textarea
                rows={3}
                value={allowedActionsText}
                onChange={(e) => setAllowedActionsText(e.target.value)}
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 font-mono focus:outline-none"
                placeholder="One action per line..."
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Restricted Actions (Strict Mandates)</label>
              <textarea
                rows={3}
                value={restrictedActionsText}
                onChange={(e) => setRestrictedActionsText(e.target.value)}
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 font-mono focus:outline-none"
                placeholder="Never fabricate prices, never give unauthorized discounts..."
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Human Escalation Triggers</label>
              <textarea
                rows={2}
                value={escalationRulesText}
                onChange={(e) => setEscalationRulesText(e.target.value)}
                className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 font-mono focus:outline-none"
                placeholder="When customer asks for human representative..."
              />
            </div>
          </div>

        </div>

        {/* Right Column: System Prompt Instructions */}
        <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4 flex flex-col">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2">
              <Sparkles className="w-4 h-4 text-purple-600" />
              <span>Full System Prompt Instructions</span>
            </h3>
            <span className="text-[10px] text-slate-400">Fed to Gemini Model</span>
          </div>

          <textarea
            rows={18}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            className="w-full flex-1 p-3.5 bg-slate-900 text-slate-100 border border-slate-800 rounded-xl text-xs font-mono leading-relaxed focus:outline-none focus:border-blue-500"
          />

          <p className="text-[11px] text-slate-500">
            Note: The agent runtime automatically appends live database facts, retrieved knowledge chunks, and tool schemas to this system prompt at execution time.
          </p>
        </div>

      </div>

    </div>
  );
};
