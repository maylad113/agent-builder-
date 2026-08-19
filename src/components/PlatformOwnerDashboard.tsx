import React, { useState } from 'react';
import { Business, Agent, AgentTemplate, AuditLog } from '../types';
import { OrchestrationView } from './OrchestrationView';
import { 
  Building2, 
  Bot, 
  MessageSquare, 
  Calendar, 
  ShoppingBag, 
  DollarSign, 
  Copy, 
  Play, 
  Pause, 
  ExternalLink, 
  Plus, 
  Search, 
  Sparkles, 
  Activity, 
  ShieldCheck,
  Zap,
  CheckCircle2,
  AlertCircle,
  FileText
} from 'lucide-react';

interface PlatformOwnerDashboardProps {
  businesses: Business[];
  agents: Agent[];
  templates: AgentTemplate[];
  auditLogs: AuditLog[];
  onSelectBusiness: (bizId: string) => void;
  onOpenWizard: () => void;
  onDuplicateBusiness: (bizId: string, newName: string) => void;
  onRefreshData: () => void;
}

export const PlatformOwnerDashboard: React.FC<PlatformOwnerDashboardProps> = ({
  businesses,
  agents,
  templates,
  auditLogs,
  onSelectBusiness,
  onOpenWizard,
  onDuplicateBusiness,
  onRefreshData
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [duplicatingBizId, setDuplicatingBizId] = useState<string | null>(null);
  const [duplicateNameInput, setDuplicateNameInput] = useState('');
  const [activeTab, setActiveTab] = useState<'businesses' | 'templates' | 'analytics' | 'logs' | 'orchestration'>('businesses');

  const filteredBusinesses = businesses.filter(b => {
    const matchesSearch = b.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          b.description.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesType = filterType === 'all' || b.type === filterType;
    return matchesSearch && matchesType;
  });

  const activeAgentsCount = agents.filter(a => a.status === 'ACTIVE').length;
  const readyAgentsCount = agents.filter(a => a.status === 'READY' || a.status === 'TESTING').length;

  const handleDuplicateSubmit = (bizId: string) => {
    if (!duplicateNameInput.trim()) return;
    onDuplicateBusiness(bizId, duplicateNameInput.trim());
    setDuplicatingBizId(null);
    setDuplicateNameInput('');
  };

  return (
    <div className="space-y-8 pb-12">
      
      {/* Top Welcome Banner */}
      <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 rounded-2xl p-6 text-white border border-slate-800 shadow-xl flex flex-col md:flex-row md:items-center md:justify-between gap-6">
        <div>
          <div className="flex items-center space-x-2 text-blue-400 text-xs font-semibold uppercase tracking-wider mb-2">
            <Zap className="w-4 h-4" />
            <span>Platform Admin Control Center</span>
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">AI Agent Factory Overview</h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Create, deploy, duplicate, and manage multi-tenant AI business receptionists across barbershops, salons, clinics, restaurants, and retail stores.
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={onOpenWizard}
            className="flex items-center space-x-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2.5 rounded-xl shadow-lg transition-all active:scale-95"
          >
            <Plus className="w-4 h-4" />
            <span>Create New Business</span>
          </button>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        
        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Total Businesses</span>
            <Building2 className="w-4 h-4 text-blue-600" />
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">{businesses.length}</div>
          <p className="text-[11px] text-emerald-600 mt-1 font-medium">100% Tenant Isolated</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Active Agents</span>
            <Bot className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">{activeAgentsCount}</div>
          <p className="text-[11px] text-slate-500 mt-1">{readyAgentsCount} Testing / Ready</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Conversations</span>
            <MessageSquare className="w-4 h-4 text-indigo-600" />
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">24</div>
          <p className="text-[11px] text-blue-600 mt-1 font-medium">Web Chat Active</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Appointments</span>
            <Calendar className="w-4 h-4 text-purple-600" />
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">12</div>
          <p className="text-[11px] text-emerald-600 mt-1 font-medium">Auto-Booked</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Products & Orders</span>
            <ShoppingBag className="w-4 h-4 text-amber-600" />
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">8</div>
          <p className="text-[11px] text-slate-500 mt-1">Retail Orders</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Est. AI Cost</span>
            <DollarSign className="w-4 h-4 text-emerald-600" />
          </div>
          <div className="mt-3 text-2xl font-bold text-slate-900">$0.02</div>
          <p className="text-[11px] text-slate-500 mt-1">~18.5k Tokens</p>
        </div>

      </div>

      {/* Tabs Navigation */}
      <div className="border-b border-slate-200 flex items-center justify-between">
        <div className="flex space-x-6 text-sm font-medium">
          <button
            onClick={() => setActiveTab('businesses')}
            className={`pb-3 border-b-2 transition-colors ${
              activeTab === 'businesses'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Businesses Directory ({businesses.length})
          </button>
          <button
            onClick={() => setActiveTab('templates')}
            className={`pb-3 border-b-2 transition-colors ${
              activeTab === 'templates'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Agent Templates ({templates.length})
          </button>
          <button
            onClick={() => setActiveTab('logs')}
            className={`pb-3 border-b-2 transition-colors ${
              activeTab === 'logs'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            System Audit Logs ({auditLogs.length})
          </button>
          <button
            onClick={() => setActiveTab('orchestration')}
            className={`pb-3 border-b-2 transition-colors ${
              activeTab === 'orchestration'
                ? 'border-blue-600 text-blue-600 font-semibold'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            Orchestration
          </button>
        </div>
      </div>

      {/* Tab 1: Businesses Directory */}
      {activeTab === 'businesses' && (
        <div className="space-y-4">
          
          {/* Search and Filters */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200/80">
            <div className="relative w-full sm:w-80">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
              <input
                type="text"
                placeholder="Search business name..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-9 pr-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="flex items-center space-x-3 w-full sm:w-auto">
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value)}
                className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:border-blue-500"
              >
                <option value="all">All Business Types</option>
                <option value="barbershop">Barbershop</option>
                <option value="salon">Salon</option>
                <option value="restaurant">Restaurant</option>
                <option value="dentist">Dentist</option>
                <option value="mechanic">Mechanic</option>
                <option value="retail">Retail</option>
              </select>
            </div>
          </div>

          {/* Business Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredBusinesses.map(biz => {
              const bizAgent = agents.find(a => a.businessId === biz.id);
              const isDuplicatingThis = duplicatingBizId === biz.id;

              return (
                <div 
                  key={biz.id}
                  className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between"
                >
                  <div>
                    {/* Header */}
                    <div className="flex items-start justify-between">
                      <div>
                        <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200">
                          {biz.type}
                        </span>
                        <h3 className="text-lg font-bold text-slate-900 mt-1.5">{biz.name}</h3>
                      </div>
                      <span className={`px-2.5 py-1 text-xs font-semibold rounded-full flex items-center space-x-1 ${
                        biz.status === 'ACTIVE' 
                          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' 
                          : 'bg-amber-50 text-amber-700 border border-amber-200'
                      }`}>
                        <span className={`w-2 h-2 rounded-full ${biz.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                        <span className="capitalize">{biz.status}</span>
                      </span>
                    </div>

                    <p className="text-xs text-slate-600 mt-2 line-clamp-2">{biz.description}</p>

                    {/* Agent Status Sub-box */}
                    <div className="mt-4 p-3 bg-slate-50 rounded-xl border border-slate-200/60 text-xs space-y-1.5">
                      <div className="flex items-center justify-between font-semibold text-slate-800">
                        <div className="flex items-center space-x-1.5">
                          <Bot className="w-3.5 h-3.5 text-blue-600" />
                          <span>{bizAgent ? bizAgent.name : 'No Agent Configured'}</span>
                        </div>
                        {bizAgent && (
                          <span className="text-[10px] text-slate-500">v{bizAgent.version}</span>
                        )}
                      </div>
                      <div className="flex items-center justify-between text-slate-500 text-[11px]">
                        <span>Services: {biz.services.length} items</span>
                        <span>Currency: {biz.currency}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions Bar */}
                  <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between gap-2">
                    <button
                      onClick={() => onSelectBusiness(biz.id)}
                      className="flex-1 flex items-center justify-center space-x-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold py-2 px-3 rounded-lg transition-colors"
                    >
                      <span>Open Portal</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </button>

                    <button
                      onClick={() => setDuplicatingBizId(isDuplicatingThis ? null : biz.id)}
                      title="Duplicate Business & Agent"
                      className="flex items-center justify-center bg-slate-100 hover:bg-slate-200 text-slate-700 p-2 rounded-lg transition-colors"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Inline Duplicate Popup */}
                  {isDuplicatingThis && (
                    <div className="mt-3 p-3 bg-blue-50 border border-blue-200 rounded-xl text-xs space-y-2">
                      <p className="font-semibold text-blue-900">Duplicate to new business:</p>
                      <input
                        type="text"
                        placeholder="e.g. John's Barber Shop"
                        value={duplicateNameInput}
                        onChange={(e) => setDuplicateNameInput(e.target.value)}
                        className="w-full px-2.5 py-1.5 bg-white border border-blue-300 rounded text-xs text-slate-800 focus:outline-none"
                      />
                      <div className="flex justify-end space-x-2">
                        <button
                          onClick={() => setDuplicatingBizId(null)}
                          className="px-2 py-1 text-slate-600 hover:text-slate-800 text-[11px]"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => handleDuplicateSubmit(biz.id)}
                          className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded font-semibold text-[11px]"
                        >
                          Duplicate Now
                        </button>
                      </div>
                    </div>
                  )}

                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Tab 2: Agent Templates */}
      {activeTab === 'templates' && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {templates.map(tpl => (
            <div key={tpl.id} className="bg-white rounded-2xl border border-slate-200/80 p-6 shadow-sm space-y-4">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600 font-bold text-lg">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900">{tpl.name}</h3>
                  <span className="text-[11px] font-semibold text-slate-500 capitalize">{tpl.businessType}</span>
                </div>
              </div>
              <p className="text-xs text-slate-600">{tpl.description}</p>
              
              <div className="text-xs space-y-1 bg-slate-50 p-3 rounded-xl border border-slate-100">
                <p className="font-semibold text-slate-700">Pre-configured Defaults:</p>
                <p className="text-slate-500">• Services: {tpl.defaultServices.length} preset services</p>
                <p className="text-slate-500">• FAQs: {tpl.defaultFaqs.length} initial FAQs</p>
              </div>

              <button
                onClick={onOpenWizard}
                className="w-full flex items-center justify-center space-x-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold py-2.5 rounded-xl transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span>Use This Template</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Tab 3: System Audit Logs */}
      {activeTab === 'logs' && (
        <div className="bg-white rounded-2xl border border-slate-200/80 overflow-hidden shadow-sm">
          <div className="p-4 bg-slate-50 border-b border-slate-200 font-semibold text-xs text-slate-700">
            Platform System Audit Feed
          </div>
          <div className="divide-y divide-slate-100">
            {auditLogs.map(log => (
              <div key={log.id} className="p-4 flex items-start justify-between text-xs hover:bg-slate-50/50">
                <div className="space-y-1">
                  <div className="flex items-center space-x-2">
                    <span className="font-bold px-2 py-0.5 rounded bg-slate-100 text-slate-800 text-[10px]">
                      {log.action}
                    </span>
                    <span className="text-slate-500">{new Date(log.timestamp).toLocaleTimeString()}</span>
                  </div>
                  <p className="text-slate-800 font-medium">{log.details}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Orchestration (Sales & Delivery pipeline) */}
      {activeTab === 'orchestration' && <OrchestrationView />}

    </div>
  );
};
