import React from 'react';
import { Business } from '../types';
import { 
  Bot, 
  Building2, 
  Sparkles, 
  UserCheck, 
  PlusCircle, 
  Layers, 
  Activity 
} from 'lucide-react';

interface NavbarProps {
  viewMode: 'platform_owner' | 'business_owner';
  setViewMode: (mode: 'platform_owner' | 'business_owner') => void;
  businesses: Business[];
  selectedBusinessId: string;
  setSelectedBusinessId: (id: string) => void;
  onOpenWizard: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  viewMode,
  setViewMode,
  businesses,
  selectedBusinessId,
  setSelectedBusinessId,
  onOpenWizard
}) => {
  const currentBiz = businesses.find(b => b.id === selectedBusinessId);

  return (
    <header className="bg-slate-900 text-white border-b border-slate-800 sticky top-0 z-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        
        {/* Brand & Logo */}
        <div className="flex items-center space-x-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-blue-500/20">
            <Bot className="w-6 h-6 text-white" />
          </div>
          <div>
            <div className="flex items-center space-x-2">
              <span className="font-bold text-lg tracking-tight text-white">AI Agent Factory</span>
              <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded bg-blue-500/20 text-blue-400 font-semibold border border-blue-500/30">
                SaaS v1.0
              </span>
            </div>
            <p className="text-xs text-slate-400 hidden sm:block">Multi-Tenant Business Receptionist Platform</p>
          </div>
        </div>

        {/* View Mode & Tenant Selector Controls */}
        <div className="flex items-center space-x-3">
          
          {/* Mode Switcher Buttons */}
          <div className="bg-slate-800 p-1 rounded-lg border border-slate-700/60 flex items-center text-xs font-medium">
            <button
              onClick={() => setViewMode('platform_owner')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md transition-colors ${
                viewMode === 'platform_owner'
                  ? 'bg-blue-600 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <UserCheck className="w-3.5 h-3.5" />
              <span>Platform Admin</span>
            </button>
            <button
              onClick={() => setViewMode('business_owner')}
              className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-md transition-colors ${
                viewMode === 'business_owner'
                  ? 'bg-blue-600 text-white shadow-sm font-semibold'
                  : 'text-slate-400 hover:text-white'
              }`}
            >
              <Building2 className="w-3.5 h-3.5" />
              <span>Business Portal</span>
            </button>
          </div>

          {/* Business Selector (When in Business Portal) */}
          {viewMode === 'business_owner' && (
            <div className="flex items-center space-x-2">
              <select
                value={selectedBusinessId}
                onChange={(e) => setSelectedBusinessId(e.target.value)}
                className="bg-slate-800 text-slate-200 text-xs font-medium border border-slate-700 rounded-lg px-3 py-1.5 focus:outline-none focus:border-blue-500 max-w-[200px] truncate"
              >
                {businesses.map(b => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.type})
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Create Business Wizard Button */}
          <button
            onClick={onOpenWizard}
            className="flex items-center space-x-1.5 bg-gradient-to-r from-emerald-600 to-teal-500 hover:from-emerald-500 hover:to-teal-400 text-white text-xs font-semibold px-3.5 py-1.5 rounded-lg shadow-md transition-all active:scale-95"
          >
            <PlusCircle className="w-4 h-4" />
            <span className="hidden md:inline">New Business</span>
          </button>

        </div>

      </div>
    </header>
  );
};
