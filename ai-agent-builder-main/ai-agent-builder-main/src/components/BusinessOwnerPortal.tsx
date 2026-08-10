import React, { useState } from 'react';
import { Business, Agent, Appointment, Product, Order, ChannelConfig, IntegrationConfig } from '../types';
import { AgentBuilder } from './AgentBuilder';
import { AgentSimulator } from './AgentSimulator';
import { WebsiteChatWidgetDemo } from './WebsiteChatWidgetDemo';
import { ConversationsView } from './ConversationsView';
import { ChannelsAndIntegrations } from './ChannelsAndIntegrations';
import { 
  Bot, 
  MessageSquare, 
  Calendar, 
  ShoppingBag, 
  BookOpen, 
  Globe, 
  Settings, 
  Building2, 
  Sparkles, 
  Plus, 
  Clock, 
  CheckCircle2, 
  Trash2,
  Sliders,
  DollarSign,
  Scissors
} from 'lucide-react';

interface BusinessOwnerPortalProps {
  business: Business;
  agent: Agent;
  appointments: Appointment[];
  products: Product[];
  orders: Order[];
  channels: ChannelConfig[];
  integrations: IntegrationConfig[];
  onUpdateAgent: (updated: Partial<Agent>) => void;
  onToggleAgentStatus: (status: 'DRAFT' | 'TESTING' | 'READY' | 'ACTIVE' | 'PAUSED') => void;
  onRefreshData: () => void;
}

export const BusinessOwnerPortal: React.FC<BusinessOwnerPortalProps> = ({
  business,
  agent,
  appointments,
  products,
  orders,
  channels,
  integrations,
  onUpdateAgent,
  onToggleAgentStatus,
  onRefreshData
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'agent' | 'conversations' | 'appointments' | 'products' | 'knowledge' | 'channels' | 'simulator' | 'widget'>('overview');

  // New Knowledge Chunk State
  const [newKbTitle, setNewKbTitle] = useState('');
  const [newKbType, setNewKbType] = useState<'faq' | 'document' | 'service_catalog' | 'policy'>('faq');
  const [newKbContent, setNewKbContent] = useState('');

  // New Appointment State
  const [newAppCustName, setNewAppCustName] = useState('');
  const [newAppCustPhone, setNewAppCustPhone] = useState('');
  const [newAppDate, setNewAppDate] = useState(new Date().toISOString().split('T')[0]);
  const [newAppTime, setNewAppTime] = useState('15:00');

  const handleAddKbItem = async () => {
    if (!newKbTitle || !newKbContent) return;
    try {
      await fetch('/api/knowledge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          title: newKbTitle,
          type: newKbType,
          content: newKbContent
        })
      });
      setNewKbTitle('');
      setNewKbContent('');
      onRefreshData();
    } catch (err) {
      console.error(err);
    }
  };

  const handleAddAppointment = async () => {
    if (!newAppCustName || !newAppCustPhone) return;
    try {
      await fetch('/api/appointments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          serviceId: business.services[0]?.id || 'srv-1',
          customerName: newAppCustName,
          customerPhone: newAppCustPhone,
          date: newAppDate,
          startTime: newAppTime
        })
      });
      setNewAppCustName('');
      setNewAppCustPhone('');
      onRefreshData();
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-6 pb-12">
      
      {/* Business Portal Banner */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2 text-blue-600 text-xs font-bold uppercase tracking-wider mb-1">
            <Building2 className="w-4 h-4" />
            <span>Business Portal</span>
          </div>
          <h1 className="text-2xl font-extrabold text-slate-900">{business.name}</h1>
          <p className="text-xs text-slate-500 mt-1">
            {business.type} • {business.location} • Timezone: {business.timezone}
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-right">
            <p className="text-[10px] text-slate-400 font-semibold uppercase">Active Agent</p>
            <p className="text-xs font-bold text-slate-900">{agent ? agent.name : 'Not Configured'}</p>
          </div>
        </div>
      </div>

      {/* Navigation Sub-Tabs */}
      <div className="border-b border-slate-200 overflow-x-auto flex space-x-6 text-xs font-semibold">
        <button
          onClick={() => setActiveTab('overview')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'overview' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Building2 className="w-4 h-4" />
          <span>Dashboard Overview</span>
        </button>

        <button
          onClick={() => setActiveTab('agent')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'agent' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Bot className="w-4 h-4" />
          <span>AI Agent Builder</span>
        </button>

        <button
          onClick={() => setActiveTab('simulator')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'simulator' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Sparkles className="w-4 h-4 text-purple-600" />
          <span>Agent Simulator</span>
        </button>

        <button
          onClick={() => setActiveTab('conversations')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'conversations' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <MessageSquare className="w-4 h-4" />
          <span>Conversations & Handoff</span>
        </button>

        <button
          onClick={() => setActiveTab('appointments')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'appointments' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Calendar className="w-4 h-4" />
          <span>Appointments ({appointments.length})</span>
        </button>

        <button
          onClick={() => setActiveTab('products')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'products' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <ShoppingBag className="w-4 h-4" />
          <span>Products & Orders</span>
        </button>

        <button
          onClick={() => setActiveTab('knowledge')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'knowledge' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <BookOpen className="w-4 h-4" />
          <span>Knowledge Base</span>
        </button>

        <button
          onClick={() => setActiveTab('channels')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'channels' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Globe className="w-4 h-4" />
          <span>Channels & Integrations</span>
        </button>

        <button
          onClick={() => setActiveTab('widget')}
          className={`pb-3 border-b-2 transition-colors flex items-center space-x-1.5 whitespace-nowrap ${
            activeTab === 'widget' ? 'border-blue-600 text-blue-600' : 'border-transparent text-slate-500 hover:text-slate-800'
          }`}
        >
          <Globe className="w-4 h-4 text-emerald-600" />
          <span>Embeddable Widget</span>
        </button>
      </div>

      {/* Tab: Overview */}
      {activeTab === 'overview' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
              <div className="flex items-center justify-between text-slate-500 text-xs font-semibold">
                <span>Services Configured</span>
                <Scissors className="w-4 h-4 text-blue-600" />
              </div>
              <div className="mt-3 text-2xl font-bold text-slate-900">{business.services.length} Services</div>
              <p className="text-[11px] text-slate-500 mt-1">
                {business.services.map(s => `${s.name} (${s.price} ${business.currency})`).join(', ')}
              </p>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
              <div className="flex items-center justify-between text-slate-500 text-xs font-semibold">
                <span>Booked Appointments</span>
                <Calendar className="w-4 h-4 text-emerald-600" />
              </div>
              <div className="mt-3 text-2xl font-bold text-slate-900">{appointments.length} Total</div>
              <p className="text-[11px] text-emerald-600 mt-1 font-semibold">All synced with AI calendar tool</p>
            </div>

            <div className="bg-white p-5 rounded-2xl border border-slate-200/80 shadow-sm">
              <div className="flex items-center justify-between text-slate-500 text-xs font-semibold">
                <span>Retail Products</span>
                <ShoppingBag className="w-4 h-4 text-amber-600" />
              </div>
              <div className="mt-3 text-2xl font-bold text-slate-900">{products.length} Products</div>
              <p className="text-[11px] text-slate-500 mt-1">{orders.length} Orders Processed</p>
            </div>
          </div>
        </div>
      )}

      {/* Tab: AI Agent Builder */}
      {activeTab === 'agent' && agent && (
        <AgentBuilder
          agent={agent}
          onUpdateAgent={onUpdateAgent}
          onToggleStatus={onToggleAgentStatus}
        />
      )}

      {/* Tab: Agent Simulator */}
      {activeTab === 'simulator' && agent && (
        <AgentSimulator business={business} agent={agent} />
      )}

      {/* Tab: Conversations */}
      {activeTab === 'conversations' && (
        <ConversationsView business={business} />
      )}

      {/* Tab: Appointments Manager */}
      {activeTab === 'appointments' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4">
            <h3 className="font-bold text-slate-900 text-sm">Schedule New Appointment</h3>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <input
                type="text"
                placeholder="Customer Name"
                value={newAppCustName}
                onChange={(e) => setNewAppCustName(e.target.value)}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
              />
              <input
                type="text"
                placeholder="Phone Number"
                value={newAppCustPhone}
                onChange={(e) => setNewAppCustPhone(e.target.value)}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
              />
              <input
                type="date"
                value={newAppDate}
                onChange={(e) => setNewAppDate(e.target.value)}
                className="px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
              />
              <button
                onClick={handleAddAppointment}
                className="bg-blue-600 hover:bg-blue-500 text-white font-semibold text-xs rounded-xl py-2"
              >
                Book Appointment
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200/80 overflow-hidden shadow-sm">
            <div className="p-4 bg-slate-50 border-b border-slate-200 font-semibold text-xs text-slate-700">
              Appointments Schedule ({appointments.length})
            </div>
            <div className="divide-y divide-slate-100">
              {appointments.map(app => (
                <div key={app.id} className="p-4 flex items-center justify-between text-xs">
                  <div>
                    <span className="font-bold text-slate-900">{app.customerName}</span>
                    <span className="text-slate-500 ml-2">({app.customerPhone})</span>
                    <p className="text-slate-600 mt-0.5">{app.serviceName} • {app.date} at {app.startTime}</p>
                  </div>
                  <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase bg-emerald-100 text-emerald-800">
                    {app.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab: Knowledge Base */}
      {activeTab === 'knowledge' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-3">
            <h3 className="font-bold text-slate-900 text-sm">Add Knowledge Chunk / Policy</h3>
            <div className="grid grid-cols-2 gap-3">
              <input
                type="text"
                placeholder="Title e.g. Parking & Location Info"
                value={newKbTitle}
                onChange={(e) => setNewKbTitle(e.target.value)}
                className="px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
              />
              <select
                value={newKbType}
                onChange={(e) => setNewKbType(e.target.value as any)}
                className="px-3.5 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
              >
                <option value="faq">FAQ</option>
                <option value="document">Document</option>
                <option value="service_catalog">Service Catalog</option>
                <option value="policy">Policy</option>
              </select>
            </div>
            <textarea
              rows={3}
              placeholder="Full text content for AI grounding..."
              value={newKbContent}
              onChange={(e) => setNewKbContent(e.target.value)}
              className="w-full p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none"
            />
            <button
              onClick={handleAddKbItem}
              className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-semibold"
            >
              Add to Knowledge Base
            </button>
          </div>
        </div>
      )}

      {/* Tab: Products & Orders */}
      {activeTab === 'products' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4">
            <h3 className="font-bold text-slate-900 text-sm">Product Inventory</h3>
            <div className="space-y-2">
              {products.map(p => (
                <div key={p.id} className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between text-xs">
                  <div>
                    <p className="font-bold text-slate-900">{p.name}</p>
                    <p className="text-slate-500">Stock: {p.inventory} units</p>
                  </div>
                  <span className="font-bold text-blue-600">{p.price} {business.currency}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4">
            <h3 className="font-bold text-slate-900 text-sm">Customer Orders</h3>
            <div className="space-y-2">
              {orders.map(o => (
                <div key={o.id} className="p-3 bg-slate-50 rounded-xl border border-slate-200 flex items-center justify-between text-xs">
                  <div>
                    <p className="font-bold text-slate-900">Order #{o.id} — {o.customerName}</p>
                    <p className="text-slate-500">{o.items.map(i => `${i.productName} (x${i.quantity})`).join(', ')}</p>
                  </div>
                  <span className="font-bold text-emerald-600">{o.totalAmount} {business.currency}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab: Channels */}
      {activeTab === 'channels' && (
        <ChannelsAndIntegrations
          business={business}
          channels={channels}
          integrations={integrations}
          onConnectIntegration={() => {}}
          onRefreshData={onRefreshData}
        />
      )}

      {/* Tab: Embeddable Widget */}
      {activeTab === 'widget' && (
        <WebsiteChatWidgetDemo business={business} />
      )}

    </div>
  );
};
