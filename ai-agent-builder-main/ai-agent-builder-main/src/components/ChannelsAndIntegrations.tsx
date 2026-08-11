import React, { useState } from 'react';
import { ChannelConfig, IntegrationConfig, Business } from '../types';
import { 
  Globe, 
  Instagram, 
  MessageSquare, 
  PhoneCall, 
  Calendar, 
  CheckCircle2, 
  AlertCircle,
  Key, 
  Settings,
  X,
  Sliders,
  ShieldCheck,
  Check
} from 'lucide-react';

interface ChannelsAndIntegrationsProps {
  business: Business;
  channels: ChannelConfig[];
  integrations: IntegrationConfig[];
  onConnectIntegration?: (provider: string) => void;
  onRefreshData?: () => void;
}

export const ChannelsAndIntegrations: React.FC<ChannelsAndIntegrationsProps> = ({
  business,
  channels,
  integrations,
  onRefreshData
}) => {
  const [activeTab, setActiveTab] = useState<'channels' | 'integrations'>('integrations');

  // Modal State for configuring a specific integration or channel
  const [configuringItem, setConfiguringItem] = useState<{
    type: 'integration' | 'channel';
    id: string;
    name: string;
    providerKey: string;
    fields: { key: string; label: string; placeholder: string; secret?: boolean }[];
  } | null>(null);

  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  const getIntegrationConfig = (provider: string) => {
    return integrations.find(i => i.provider === provider);
  };

  const getChannelConfig = (type: string) => {
    return channels.find(c => c.type === type);
  };

  const handleOpenConfig = (
    type: 'integration' | 'channel',
    id: string,
    name: string,
    providerKey: string,
    fields: { key: string; label: string; placeholder: string; secret?: boolean }[]
  ) => {
    // Find existing stored config if any
    let existingData: Record<string, string> = {};
    if (type === 'integration') {
      const found = integrations.find(i => i.id === id || i.provider === providerKey);
      if (found && found.configData) existingData = found.configData;
    } else {
      const found = channels.find(c => c.id === id || c.type === providerKey);
      if (found && found.configData) existingData = found.configData;
    }

    setFormValues(existingData);
    setSaveSuccess(false);
    setConfiguringItem({ type, id, name, providerKey, fields });
  };

  const handleSaveConfig = async () => {
    if (!configuringItem) return;
    setIsSaving(true);
    setSaveSuccess(false);

    try {
      if (configuringItem.type === 'integration') {
        const item = integrations.find(i => i.id === configuringItem.id || i.provider === configuringItem.providerKey);
        const targetId = item ? item.id : `integ-${Date.now()}-${configuringItem.providerKey}`;

        // Two-step secure connect (P1.1): submit credentials server-side, then
        // validate. The server ONLY marks the integration CONNECTED after the
        // provider confirms the credentials actually work. The frontend never
        // sets `state=CONNECTED` directly.
        await fetch(`/api/integrations/${targetId}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credentials: formValues })
        });
        const validateRes = await fetch(`/api/integrations/${targetId}/validate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
        const outcome = await validateRes.json().catch(() => ({}));
        if (outcome.state !== 'CONNECTED') {
          setSaveSuccess(false);
          alert(`Could not validate integration: ${outcome.statusMessage || outcome.lastError || 'unknown error'}`);
        } else {
          setSaveSuccess(true);
        }
      } else {
        const item = channels.find(c => c.id === configuringItem.id || c.type === configuringItem.providerKey);
        const targetId = item ? item.id : `chan-${Date.now()}-${configuringItem.providerKey}`;

        await fetch(`/api/channels/${targetId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'connected',
            details: 'Configured & Connected',
            configData: formValues
          })
        });
        setSaveSuccess(true);
      }

      if (onRefreshData) onRefreshData();

      if (saveSuccess || configuringItem.type === 'channel') {
        setTimeout(() => {
          setConfiguringItem(null);
          setSaveSuccess(false);
        }, 1200);
      }
    } catch (err) {
      console.error('Save integration error:', err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisconnect = async (type: 'integration' | 'channel', id: string, providerKey: string) => {
    try {
      if (type === 'integration') {
        await fetch(`/api/integrations/${id}/disconnect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        await fetch(`/api/channels/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'not_configured',
            details: 'Not configured',
            configData: {}
          })
        });
      }
      if (onRefreshData) onRefreshData();
    } catch (err) {
      console.error('Disconnect error:', err);
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Header */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Channels & External Integrations</h2>
          <p className="text-xs text-slate-500 mt-1">
            Optional external integrations for {business.name}. Configure credentials only for services you wish to use.
          </p>
        </div>

        <div className="flex bg-slate-100 p-1 rounded-xl text-xs font-semibold">
          <button
            onClick={() => setActiveTab('integrations')}
            className={`px-3 py-1.5 rounded-lg transition-colors ${
              activeTab === 'integrations' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Provider Credentials
          </button>
          <button
            onClick={() => setActiveTab('channels')}
            className={`px-3 py-1.5 rounded-lg transition-colors ${
              activeTab === 'channels' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Communication Channels
          </button>
        </div>
      </div>

      {/* Info Notice */}
      <div className="bg-blue-50/80 border border-blue-200/80 rounded-2xl p-4 flex items-start space-x-3 text-blue-900 text-xs leading-relaxed">
        <ShieldCheck className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
        <div>
          <p className="font-bold text-blue-950">Modular & Optional Architecture</p>
          <p className="mt-0.5 text-blue-800">
            External integrations are strictly optional. The core application (Dashboard, AI Agent Simulator, Business Creation, Knowledge Base, Appointments, and Web Chat Widget) runs independently without external credentials.
          </p>
        </div>
      </div>

      {/* Tab 1: External Integrations */}
      {activeTab === 'integrations' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          
          {/* Google Calendar */}
          {(() => {
            const integ = getIntegrationConfig('google_calendar');
            const isConnected = (integ?.state === 'CONNECTED') || false;
            return (
              <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600">
                        <Calendar className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 text-sm">Google Calendar Integration</h3>
                        <p className="text-[11px] text-slate-500">OAuth appointment synchronization</p>
                      </div>
                    </div>
                    {isConnected ? (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center space-x-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Configured</span>
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        Not configured
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 mt-3 leading-relaxed">
                    Automatically sync appointments booked by the AI receptionist directly with staff Google Calendars.
                  </p>
                </div>

                <div className="pt-2 flex items-center justify-between border-t border-slate-100">
                  {isConnected ? (
                    <div className="flex items-center space-x-2 w-full justify-between">
                      <button
                        onClick={() => handleOpenConfig('integration', integ?.id || '', 'Google Calendar Integration', 'google_calendar', [
                          { key: 'GOOGLE_CLIENT_ID', label: 'Google Client ID', placeholder: 'your-client-id.apps.googleusercontent.com' },
                          { key: 'GOOGLE_CLIENT_SECRET', label: 'Google Client Secret', placeholder: 'GOCSPX-your-secret-key', secret: true },
                          { key: 'GOOGLE_REDIRECT_URI', label: 'Redirect URI', placeholder: 'https://your-domain.com/auth/google/callback' }
                        ])}
                        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold transition-colors flex items-center space-x-1"
                      >
                        <Settings className="w-3.5 h-3.5" />
                        <span>Edit Credentials</span>
                      </button>
                      <button
                        onClick={() => handleDisconnect('integration', integ?.id || '', 'google_calendar')}
                        className="text-xs text-rose-600 hover:text-rose-800 font-semibold"
                      >
                        Disconnect
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleOpenConfig('integration', integ?.id || 'integ-gcal', 'Google Calendar Integration', 'google_calendar', [
                        { key: 'GOOGLE_CLIENT_ID', label: 'Google Client ID', placeholder: 'your-client-id.apps.googleusercontent.com' },
                        { key: 'GOOGLE_CLIENT_SECRET', label: 'Google Client Secret', placeholder: 'GOCSPX-your-secret-key', secret: true },
                        { key: 'GOOGLE_REDIRECT_URI', label: 'Redirect URI', placeholder: 'https://your-domain.com/auth/google/callback' }
                      ])}
                      className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-1"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Configure</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Meta Instagram */}
          {(() => {
            const integ = getIntegrationConfig('meta_instagram');
            const isConnected = (integ?.state === 'CONNECTED') || false;
            return (
              <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-xl bg-pink-50 border border-pink-100 flex items-center justify-center text-pink-600">
                        <Instagram className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 text-sm">Meta Instagram Graph API</h3>
                        <p className="text-[11px] text-slate-500">Official Direct Messaging Webhook</p>
                      </div>
                    </div>
                    {isConnected ? (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center space-x-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Configured</span>
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        Not configured
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 mt-3 leading-relaxed">
                    Connect official Instagram Graph Webhooks to allow the AI agent to respond to Instagram Direct Messages.
                  </p>
                </div>

                <div className="pt-2 flex items-center justify-between border-t border-slate-100">
                  {isConnected ? (
                    <div className="flex items-center space-x-2 w-full justify-between">
                      <button
                        onClick={() => handleOpenConfig('integration', integ?.id || '', 'Meta Instagram Graph API', 'meta_instagram', [
                          { key: 'META_APP_ID', label: 'Meta App ID', placeholder: 'e.g. 123456789012345' },
                          { key: 'META_APP_SECRET', label: 'Meta App Secret', placeholder: 'App Secret Key', secret: true },
                          { key: 'META_VERIFY_TOKEN', label: 'Webhook Verify Token', placeholder: 'Custom verify token string' }
                        ])}
                        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold transition-colors flex items-center space-x-1"
                      >
                        <Settings className="w-3.5 h-3.5" />
                        <span>Edit Credentials</span>
                      </button>
                      <button
                        onClick={() => handleDisconnect('integration', integ?.id || '', 'meta_instagram')}
                        className="text-xs text-rose-600 hover:text-rose-800 font-semibold"
                      >
                        Disconnect
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleOpenConfig('integration', integ?.id || 'integ-meta', 'Meta Instagram Graph API', 'meta_instagram', [
                        { key: 'META_APP_ID', label: 'Meta App ID', placeholder: 'e.g. 123456789012345' },
                        { key: 'META_APP_SECRET', label: 'Meta App Secret', placeholder: 'App Secret Key', secret: true },
                        { key: 'META_VERIFY_TOKEN', label: 'Webhook Verify Token', placeholder: 'Custom verify token string' }
                      ])}
                      className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-1"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Configure</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Twilio SMS */}
          {(() => {
            const integ = getIntegrationConfig('twilio_sms');
            const isConnected = (integ?.state === 'CONNECTED') || false;
            return (
              <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600">
                        <MessageSquare className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 text-sm">Twilio Telephony & SMS</h3>
                        <p className="text-[11px] text-slate-500">Automated SMS notifications & callbacks</p>
                      </div>
                    </div>
                    {isConnected ? (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center space-x-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Configured</span>
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        Not configured
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 mt-3 leading-relaxed">
                    Send SMS appointment confirmations, reminders, and auto-reply to missed calls via Twilio API.
                  </p>
                </div>

                <div className="pt-2 flex items-center justify-between border-t border-slate-100">
                  {isConnected ? (
                    <div className="flex items-center space-x-2 w-full justify-between">
                      <button
                        onClick={() => handleOpenConfig('integration', integ?.id || '', 'Twilio Telephony & SMS', 'twilio_sms', [
                          { key: 'TWILIO_ACCOUNT_SID', label: 'Twilio Account SID', placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxx' },
                          { key: 'TWILIO_AUTH_TOKEN', label: 'Twilio Auth Token', placeholder: 'Auth token string', secret: true },
                          { key: 'TWILIO_PHONE_NUMBER', label: 'Twilio Phone Number', placeholder: '+18005550199' }
                        ])}
                        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold transition-colors flex items-center space-x-1"
                      >
                        <Settings className="w-3.5 h-3.5" />
                        <span>Edit Credentials</span>
                      </button>
                      <button
                        onClick={() => handleDisconnect('integration', integ?.id || '', 'twilio_sms')}
                        className="text-xs text-rose-600 hover:text-rose-800 font-semibold"
                      >
                        Disconnect
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleOpenConfig('integration', integ?.id || 'integ-twilio', 'Twilio Telephony & SMS', 'twilio_sms', [
                        { key: 'TWILIO_ACCOUNT_SID', label: 'Twilio Account SID', placeholder: 'ACxxxxxxxxxxxxxxxxxxxxxxxx' },
                        { key: 'TWILIO_AUTH_TOKEN', label: 'Twilio Auth Token', placeholder: 'Auth token string', secret: true },
                        { key: 'TWILIO_PHONE_NUMBER', label: 'Twilio Phone Number', placeholder: '+18005550199' }
                      ])}
                      className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-1"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Configure</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Voice AI */}
          {(() => {
            const integ = getIntegrationConfig('voice_ai');
            const isConnected = (integ?.state === 'CONNECTED') || false;
            return (
              <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-4 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-xl bg-purple-50 border border-purple-100 flex items-center justify-center text-purple-600">
                        <PhoneCall className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 text-sm">Voice AI Gateway</h3>
                        <p className="text-[11px] text-slate-500">SIP / Speech-to-Speech Assistant</p>
                      </div>
                    </div>
                    {isConnected ? (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center space-x-1">
                        <CheckCircle2 className="w-3 h-3" />
                        <span>Configured</span>
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        Not configured
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 mt-3 leading-relaxed">
                    Enable real-time interactive voice calls over phone lines using Gemini Live & Speech AI adapters.
                  </p>
                </div>

                <div className="pt-2 flex items-center justify-between border-t border-slate-100">
                  {isConnected ? (
                    <div className="flex items-center space-x-2 w-full justify-between">
                      <button
                        onClick={() => handleOpenConfig('integration', integ?.id || '', 'Voice AI Gateway', 'voice_ai', [
                          { key: 'VOICE_AI_API_KEY', label: 'Voice AI API Key', placeholder: 'Voice provider API key', secret: true },
                          { key: 'VOICE_AI_ENDPOINT', label: 'Voice AI Endpoint URL', placeholder: 'wss://voice-gateway.example.com/stream' }
                        ])}
                        className="px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-xl text-xs font-semibold transition-colors flex items-center space-x-1"
                      >
                        <Settings className="w-3.5 h-3.5" />
                        <span>Edit Credentials</span>
                      </button>
                      <button
                        onClick={() => handleDisconnect('integration', integ?.id || '', 'voice_ai')}
                        className="text-xs text-rose-600 hover:text-rose-800 font-semibold"
                      >
                        Disconnect
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleOpenConfig('integration', integ?.id || 'integ-voice', 'Voice AI Gateway', 'voice_ai', [
                        { key: 'VOICE_AI_API_KEY', label: 'Voice AI API Key', placeholder: 'Voice provider API key', secret: true },
                        { key: 'VOICE_AI_ENDPOINT', label: 'Voice AI Endpoint URL', placeholder: 'wss://voice-gateway.example.com/stream' }
                      ])}
                      className="w-full py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-1"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Configure</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

        </div>
      )}

      {/* Tab 2: Channels Overview */}
      {activeTab === 'channels' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          
          {/* Web Chat */}
          <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="w-10 h-10 rounded-xl bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-600">
                  <Globe className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-sm">Website Chat Widget</h3>
                  <p className="text-[11px] text-slate-500">Embedded web widget</p>
                </div>
              </div>
              <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                Connected & Ready
              </span>
            </div>
            <p className="text-xs text-slate-600 leading-relaxed">
              Active snippet available in the Embeddable Widget tab. Handles real-time AI responses, appointment booking, and human handoffs natively.
            </p>
          </div>

          {/* Instagram Channel */}
          {(() => {
            const chan = getChannelConfig('instagram');
            const isConn = chan?.status === 'connected';
            return (
              <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-3 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-xl bg-pink-50 border border-pink-100 flex items-center justify-center text-pink-600">
                        <Instagram className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 text-sm">Instagram Direct Messaging</h3>
                        <p className="text-[11px] text-slate-500">Instagram DM channel</p>
                      </div>
                    </div>
                    {isConn ? (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                        Connected
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        Not configured
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 mt-2 leading-relaxed">
                    Auto-respond to Instagram direct messages from customers via Meta Graph API.
                  </p>
                </div>

                <div className="pt-2 border-t border-slate-100">
                  {isConn ? (
                    <button
                      onClick={() => handleDisconnect('channel', chan?.id || '', 'instagram')}
                      className="text-xs text-rose-600 hover:text-rose-800 font-semibold"
                    >
                      Disable Channel
                    </button>
                  ) : (
                    <button
                      onClick={() => handleOpenConfig('channel', chan?.id || 'chan-insta', 'Instagram Direct Messaging Channel', 'instagram', [
                        { key: 'INSTAGRAM_PAGE_ID', label: 'Instagram Page ID', placeholder: '12345678' }
                      ])}
                      className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-1"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Configure</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* SMS Channel */}
          {(() => {
            const chan = getChannelConfig('sms');
            const isConn = chan?.status === 'connected';
            return (
              <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-3 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-xl bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-600">
                        <MessageSquare className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 text-sm">SMS Channel</h3>
                        <p className="text-[11px] text-slate-500">Text message channel</p>
                      </div>
                    </div>
                    {isConn ? (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                        Connected
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        Not configured
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 mt-2 leading-relaxed">
                    SMS messaging interface for sending customer reminders and answering text queries.
                  </p>
                </div>

                <div className="pt-2 border-t border-slate-100">
                  {isConn ? (
                    <button
                      onClick={() => handleDisconnect('channel', chan?.id || '', 'sms')}
                      className="text-xs text-rose-600 hover:text-rose-800 font-semibold"
                    >
                      Disable Channel
                    </button>
                  ) : (
                    <button
                      onClick={() => handleOpenConfig('channel', chan?.id || 'chan-sms', 'SMS Communication Channel', 'sms', [
                        { key: 'SMS_SENDER_NAME', label: 'Sender ID / Name', placeholder: "e.g. Tony's Barber" }
                      ])}
                      className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-1"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Configure</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

          {/* Voice Channel */}
          {(() => {
            const chan = getChannelConfig('voice');
            const isConn = chan?.status === 'connected';
            return (
              <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm space-y-3 flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-3">
                      <div className="w-10 h-10 rounded-xl bg-purple-50 border border-purple-100 flex items-center justify-center text-purple-600">
                        <PhoneCall className="w-5 h-5" />
                      </div>
                      <div>
                        <h3 className="font-bold text-slate-900 text-sm">Voice Telephony Channel</h3>
                        <p className="text-[11px] text-slate-500">Inbound phone assistant</p>
                      </div>
                    </div>
                    {isConn ? (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                        Connected
                      </span>
                    ) : (
                      <span className="px-2.5 py-1 text-[11px] font-bold rounded-full bg-slate-100 text-slate-600 border border-slate-200">
                        Not configured
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-600 mt-2 leading-relaxed">
                    Voice hotline stream allowing customers to speak to the AI receptionist over telephone.
                  </p>
                </div>

                <div className="pt-2 border-t border-slate-100">
                  {isConn ? (
                    <button
                      onClick={() => handleDisconnect('channel', chan?.id || '', 'voice')}
                      className="text-xs text-rose-600 hover:text-rose-800 font-semibold"
                    >
                      Disable Channel
                    </button>
                  ) : (
                    <button
                      onClick={() => handleOpenConfig('channel', chan?.id || 'chan-voice', 'Voice Telephony Channel', 'voice', [
                        { key: 'VOICE_GREETING', label: 'Custom Voice Greeting', placeholder: "Hello! Welcome to Tony's Barber Shop..." }
                      ])}
                      className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-white rounded-xl text-xs font-bold transition-colors flex items-center justify-center space-x-1"
                    >
                      <Sliders className="w-3.5 h-3.5" />
                      <span>Configure</span>
                    </button>
                  )}
                </div>
              </div>
            );
          })()}

        </div>
      )}

      {/* Configuration Modal */}
      {configuringItem && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-2xl max-w-lg w-full p-6 space-y-5 animate-in fade-in zoom-in duration-150">
            
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center">
                  <Key className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-bold text-slate-900 text-base">Configure {configuringItem.name}</h3>
                  <p className="text-xs text-slate-500">Provide credentials for this integration only</p>
                </div>
              </div>
              <button
                onClick={() => setConfiguringItem(null)}
                className="p-1 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {saveSuccess ? (
              <div className="py-8 text-center space-y-3">
                <div className="w-12 h-12 rounded-full bg-emerald-100 text-emerald-600 mx-auto flex items-center justify-center">
                  <Check className="w-6 h-6" />
                </div>
                <p className="font-bold text-slate-900 text-sm">Integration Configured Successfully!</p>
                <p className="text-xs text-slate-500">Status has been set to Configured & Active.</p>
              </div>
            ) : (
              <div className="space-y-4">
                {configuringItem.fields.map(field => (
                  <div key={field.key} className="space-y-1">
                    <label className="text-xs font-bold text-slate-700 flex items-center justify-between">
                      <span>{field.label}</span>
                      <code className="text-[10px] text-slate-400 font-mono">{field.key}</code>
                    </label>
                    <input
                      type={field.secret ? 'password' : 'text'}
                      placeholder={field.placeholder}
                      value={formValues[field.key] || ''}
                      onChange={(e) => setFormValues(prev => ({ ...prev, [field.key]: e.target.value }))}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-xs font-mono text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    />
                  </div>
                ))}

                <p className="text-[11px] text-slate-500 bg-slate-50 p-3 rounded-xl border border-slate-200 leading-relaxed">
                  Only credentials for <strong>{configuringItem.name}</strong> will be saved. Other integrations remain unconfigured until explicitly enabled.
                </p>

                <div className="pt-2 flex items-center justify-end space-x-3">
                  <button
                    type="button"
                    onClick={() => setConfiguringItem(null)}
                    className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={handleSaveConfig}
                    className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl shadow-xs transition-colors flex items-center space-x-1"
                  >
                    {isSaving ? 'Saving...' : 'Save & Enable Integration'}
                  </button>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

    </div>
  );
};
