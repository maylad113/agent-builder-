import React, { useState, useEffect } from 'react';
import { Business, Agent, AgentTemplate, AuditLog, Appointment, Product, Order, ChannelConfig, IntegrationConfig } from './types';
import { Navbar } from './components/Navbar';
import { PlatformOwnerDashboard } from './components/PlatformOwnerDashboard';
import { BusinessOwnerPortal } from './components/BusinessOwnerPortal';
import { BusinessWizard } from './components/BusinessWizard';

export default function App() {
  const [viewMode, setViewMode] = useState<'platform_owner' | 'business_owner'>('platform_owner');
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>('biz-tonys-barber');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [isWizardOpen, setIsWizardOpen] = useState(false);

  // Tenant Specific Data
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [channels, setChannels] = useState<ChannelConfig[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConfig[]>([]);

  const fetchGlobalData = async () => {
    try {
      const [bizRes, agentsRes, tplRes, logsRes] = await Promise.all([
        fetch('/api/businesses'),
        fetch('/api/agents'),
        fetch('/api/templates'),
        fetch('/api/audit-logs')
      ]);

      const [bizData, agentsData, tplData, logsData] = await Promise.all([
        bizRes.json(),
        agentsRes.json(),
        tplRes.json(),
        logsRes.json()
      ]);

      setBusinesses(bizData);
      setAgents(agentsData);
      setTemplates(tplData);
      setAuditLogs(logsData);

      if (bizData.length > 0 && !selectedBusinessId) {
        setSelectedBusinessId(bizData[0].id);
      }
    } catch (err) {
      console.error('Data loading error:', err);
    }
  };

  const fetchTenantData = async (bizId: string) => {
    if (!bizId) return;
    try {
      const [appRes, prodRes, ordRes, chanRes, integRes] = await Promise.all([
        fetch(`/api/appointments?businessId=${bizId}`),
        fetch(`/api/products?businessId=${bizId}`),
        fetch(`/api/orders?businessId=${bizId}`),
        fetch(`/api/channels?businessId=${bizId}`),
        fetch(`/api/integrations?businessId=${bizId}`)
      ]);

      const [appData, prodData, ordData, chanData, integData] = await Promise.all([
        appRes.json(),
        prodRes.json(),
        ordRes.json(),
        chanRes.json(),
        integRes.json()
      ]);

      setAppointments(appData);
      setProducts(prodData);
      setOrders(ordData);
      setChannels(chanData);
      setIntegrations(integData);
    } catch (err) {
      console.error('Tenant data loading error:', err);
    }
  };

  useEffect(() => {
    fetchGlobalData();
  }, []);

  useEffect(() => {
    if (selectedBusinessId) {
      fetchTenantData(selectedBusinessId);
    }
  }, [selectedBusinessId]);

  const handleOpenTenantPortal = (bizId: string) => {
    setSelectedBusinessId(bizId);
    setViewMode('business_owner');
  };

  const handleDuplicateBusiness = async (bizId: string, newName: string) => {
    try {
      const res = await fetch(`/api/businesses/${bizId}/duplicate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newName })
      });
      if (res.ok) {
        await fetchGlobalData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleWizardComplete = async (businessData: any, agentData: any) => {
    try {
      // 1. Create Business
      const bizRes = await fetch('/api/businesses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(businessData)
      });
      const createdBiz = await bizRes.json();

      // 2. Create Agent if generated
      if (agentData && createdBiz.id) {
        await fetch('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...agentData,
            businessId: createdBiz.id
          })
        });
      }

      await fetchGlobalData();
      setSelectedBusinessId(createdBiz.id);
      setViewMode('business_owner');
    } catch (err) {
      console.error('Wizard completion error:', err);
    }
  };

  const handleUpdateAgent = async (updatedFields: Partial<Agent>) => {
    const currentAgent = agents.find(a => a.businessId === selectedBusinessId);
    if (!currentAgent) return;

    try {
      const res = await fetch(`/api/agents/${currentAgent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedFields)
      });
      if (res.ok) {
        fetchGlobalData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleToggleAgentStatus = async (status: 'DRAFT' | 'TESTING' | 'READY' | 'ACTIVE' | 'PAUSED') => {
    const currentAgent = agents.find(a => a.businessId === selectedBusinessId);
    if (!currentAgent) return;

    try {
      const res = await fetch(`/api/agents/${currentAgent.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        fetchGlobalData();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const selectedBiz = businesses.find(b => b.id === selectedBusinessId) || businesses[0];
  const selectedAgent = agents.find(a => a.businessId === selectedBusinessId) || agents[0];

  return (
    <div className="min-h-screen bg-slate-100/70 text-slate-900 font-sans antialiased">
      
      {/* Top Navbar */}
      <Navbar
        viewMode={viewMode}
        setViewMode={setViewMode}
        businesses={businesses}
        selectedBusinessId={selectedBusinessId}
        setSelectedBusinessId={setSelectedBusinessId}
        onOpenWizard={() => setIsWizardOpen(true)}
      />

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {viewMode === 'platform_owner' ? (
          <PlatformOwnerDashboard
            businesses={businesses}
            agents={agents}
            templates={templates}
            auditLogs={auditLogs}
            onSelectBusiness={handleOpenTenantPortal}
            onOpenWizard={() => setIsWizardOpen(true)}
            onDuplicateBusiness={handleDuplicateBusiness}
            onRefreshData={fetchGlobalData}
          />
        ) : (
          selectedBiz && (
            <BusinessOwnerPortal
              business={selectedBiz}
              agent={selectedAgent}
              appointments={appointments}
              products={products}
              orders={orders}
              channels={channels}
              integrations={integrations}
              onUpdateAgent={handleUpdateAgent}
              onToggleAgentStatus={handleToggleAgentStatus}
              onRefreshData={() => fetchTenantData(selectedBiz.id)}
            />
          )
        )}
      </main>

      {/* Business Wizard Modal */}
      <BusinessWizard
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onComplete={handleWizardComplete}
      />

    </div>
  );
}
