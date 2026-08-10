import React, { useState } from 'react';
import { BusinessType, ToneType, LanguageType, ServiceItem, FAQItem } from '../types';
import { 
  Sparkles, 
  X, 
  CheckCircle2, 
  ArrowRight, 
  ArrowLeft, 
  Building2, 
  Clock, 
  Scissors, 
  HelpCircle, 
  MessageSquare, 
  Bot, 
  ShieldCheck, 
  Plus, 
  Trash2,
  Loader2
} from 'lucide-react';

interface BusinessWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (businessData: any, agentData: any) => void;
}

export const BusinessWizard: React.FC<BusinessWizardProps> = ({
  isOpen,
  onClose,
  onComplete
}) => {
  const [step, setStep] = useState(1);
  const [isGenerating, setIsGenerating] = useState(false);

  // Form State
  const [name, setName] = useState('');
  const [type, setType] = useState<BusinessType>('barbershop');
  const [description, setDescription] = useState('');
  const [location, setLocation] = useState('123 Main Street');
  const [currency, setCurrency] = useState('toman');
  const [language, setLanguage] = useState<LanguageType>('en');
  
  // Services
  const [services, setServices] = useState<Array<{ name: string; price: number; durationMinutes: number; description: string }>>([
    { name: 'Haircut', price: 300000, durationMinutes: 30, description: 'Classic haircut and styling' },
    { name: 'Beard trim', price: 200000, durationMinutes: 20, description: 'Beard line-up and trim' }
  ]);
  const [newSrvName, setNewSrvName] = useState('');
  const [newSrvPrice, setNewSrvPrice] = useState('');

  // FAQs
  const [faqs, setFaqs] = useState<Array<{ question: string; answer: string }>>([
    { question: 'Do I need an appointment?', answer: 'Appointments are recommended, but walk-ins are welcome if available.' }
  ]);
  const [newFaqQ, setNewFaqQ] = useState('');
  const [newFaqA, setNewFaqA] = useState('');

  // Agent State
  const [tone, setTone] = useState<ToneType>('friendly');
  const [generatedAgentConfig, setGeneratedAgentConfig] = useState<any>(null);

  if (!isOpen) return null;

  const handleAddService = () => {
    if (!newSrvName.trim()) return;
    setServices([
      ...services,
      {
        name: newSrvName.trim(),
        price: Number(newSrvPrice) || 300000,
        durationMinutes: 30,
        description: 'Standard service'
      }
    ]);
    setNewSrvName('');
    setNewSrvPrice('');
  };

  const handleRemoveService = (idx: number) => {
    setServices(services.filter((_, i) => i !== idx));
  };

  const handleAddFaq = () => {
    if (!newFaqQ.trim() || !newFaqA.trim()) return;
    setFaqs([...faqs, { question: newFaqQ.trim(), answer: newFaqA.trim() }]);
    setNewFaqQ('');
    setNewFaqA('');
  };

  const handleGenerateAgent = async () => {
    setIsGenerating(true);
    try {
      const res = await fetch('/api/agents/generate-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name || "Tony's Barber Shop",
          type,
          description: description || "Local barbershop",
          hours: "Mon-Sat 09:00 - 20:00",
          services: services.map(s => `${s.name}: ${s.price} ${currency}`).join(', ')
        })
      });
      const data = await res.json();
      setGeneratedAgentConfig(data);
      setStep(6);
    } catch (err) {
      console.error('Generation Error:', err);
      setStep(6);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleFinalize = () => {
    const businessData = {
      name: name || "Tony's Barber Shop",
      type,
      description: description || "Local business",
      location,
      currency,
      language,
      services,
      faqs
    };

    const agentData = generatedAgentConfig ? {
      name: generatedAgentConfig.agentName || `${businessData.name} AI Receptionist`,
      systemPrompt: generatedAgentConfig.systemPrompt,
      structuredConfig: {
        personality: generatedAgentConfig.personality || { tone, behavior: 'service', language },
        goals: generatedAgentConfig.goals || ['Answer FAQs', 'Book appointments'],
        allowedActions: generatedAgentConfig.allowedActions || ['check_business_hours', 'check_availability', 'book_appointment', 'transfer_to_human'],
        restrictedActions: generatedAgentConfig.restrictedActions || ['Do not give fake prices'],
        escalationRules: generatedAgentConfig.escalationRules || ['Customer requests human'],
        bookingRules: 'Require full name and phone number',
        orderRules: 'Standard product order',
        refundRules: 'Non-refundable',
        toolsEnabled: ['check_business_hours', 'get_business_information', 'check_availability', 'book_appointment', 'transfer_to_human']
      }
    } : null;

    onComplete(businessData, agentData);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/70 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl max-w-2xl w-full border border-slate-200 shadow-2xl overflow-hidden flex flex-col my-8">
        
        {/* Modal Header */}
        <div className="bg-slate-900 text-white p-6 flex items-center justify-between border-b border-slate-800">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-xl bg-blue-600 flex items-center justify-center">
              <Sparkles className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Business Onboarding Wizard</h2>
              <p className="text-xs text-slate-400">Step {step} of 6 — Configure & Auto-Generate AI Agent</p>
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white p-1 rounded-lg">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Wizard Content Body */}
        <div className="p-6 space-y-6 flex-1 overflow-y-auto max-h-[70vh]">
          
          {/* Step 1: Basic Info */}
          {step === 1 && (
            <div className="space-y-4">
              <h3 className="font-bold text-slate-900 text-base">Step 1: Business Identity</h3>
              
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Business Name</label>
                <input
                  type="text"
                  placeholder="e.g. Tony's Barber Shop"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-blue-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Business Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as BusinessType)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-blue-500"
                  >
                    <option value="barbershop">Barbershop</option>
                    <option value="salon">Salon & Spa</option>
                    <option value="restaurant">Restaurant / Cafe</option>
                    <option value="dentist">Clinic / Dentist</option>
                    <option value="mechanic">Auto Repair</option>
                    <option value="retail">Local Retail</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">Currency</label>
                  <input
                    type="text"
                    placeholder="e.g. toman or $"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-blue-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">Business Description</label>
                <textarea
                  rows={3}
                  placeholder="Describe your services, specialties, and atmosphere..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>
          )}

          {/* Step 2: Services & Prices */}
          {step === 2 && (
            <div className="space-y-4">
              <h3 className="font-bold text-slate-900 text-base">Step 2: Services & Pricing</h3>
              
              <div className="space-y-2">
                {services.map((srv, idx) => (
                  <div key={idx} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-200/80 text-xs">
                    <div>
                      <span className="font-bold text-slate-900">{srv.name}</span>
                      <span className="text-slate-500 ml-2">({srv.durationMinutes} mins)</span>
                    </div>
                    <div className="flex items-center space-x-3">
                      <span className="font-bold text-blue-600">{srv.price} {currency}</span>
                      <button onClick={() => handleRemoveService(idx)} className="text-slate-400 hover:text-red-600">
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Add Service Box */}
              <div className="p-3 border border-dashed border-slate-300 rounded-xl space-y-2">
                <p className="text-xs font-semibold text-slate-700">Add Service</p>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    placeholder="Service Name (e.g. Haircut)"
                    value={newSrvName}
                    onChange={(e) => setNewSrvName(e.target.value)}
                    className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                  />
                  <input
                    type="number"
                    placeholder={`Price (${currency})`}
                    value={newSrvPrice}
                    onChange={(e) => setNewSrvPrice(e.target.value)}
                    className="px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                  />
                </div>
                <button
                  onClick={handleAddService}
                  className="w-full py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold flex items-center justify-center space-x-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Service Item</span>
                </button>
              </div>
            </div>
          )}

          {/* Step 3: FAQs */}
          {step === 3 && (
            <div className="space-y-4">
              <h3 className="font-bold text-slate-900 text-base">Step 3: Business FAQs</h3>

              <div className="space-y-2">
                {faqs.map((f, idx) => (
                  <div key={idx} className="p-3 bg-slate-50 rounded-xl border border-slate-200/80 text-xs space-y-1">
                    <p className="font-bold text-slate-900">Q: {f.question}</p>
                    <p className="text-slate-600">A: {f.answer}</p>
                  </div>
                ))}
              </div>

              <div className="p-3 border border-dashed border-slate-300 rounded-xl space-y-2">
                <p className="text-xs font-semibold text-slate-700">Add FAQ</p>
                <input
                  type="text"
                  placeholder="Question (e.g. Do you accept cards?)"
                  value={newFaqQ}
                  onChange={(e) => setNewFaqQ(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                />
                <input
                  type="text"
                  placeholder="Answer"
                  value={newFaqA}
                  onChange={(e) => setNewFaqA(e.target.value)}
                  className="w-full px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-xs"
                />
                <button
                  onClick={handleAddFaq}
                  className="w-full py-1.5 bg-slate-900 hover:bg-slate-800 text-white rounded-lg text-xs font-semibold"
                >
                  Add FAQ
                </button>
              </div>
            </div>
          )}

          {/* Step 4: Communication Tone */}
          {step === 4 && (
            <div className="space-y-4">
              <h3 className="font-bold text-slate-900 text-base">Step 4: AI Communication Style</h3>
              
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-2">Agent Tone</label>
                <div className="grid grid-cols-2 gap-3">
                  {(['friendly', 'professional', 'casual', 'luxury'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setTone(t)}
                      className={`p-3 rounded-xl border text-left text-xs font-semibold capitalize transition-all ${
                        tone === t
                          ? 'border-blue-600 bg-blue-50 text-blue-700'
                          : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      {t} Tone
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Step 5: AI Auto-Generation Trigger */}
          {step === 5 && (
            <div className="text-center py-8 space-y-4">
              <div className="w-16 h-16 rounded-3xl bg-blue-50 text-blue-600 border border-blue-200 flex items-center justify-center mx-auto">
                <Sparkles className="w-8 h-8 animate-pulse" />
              </div>
              <h3 className="text-xl font-extrabold text-slate-900">Auto-Generate AI Receptionist</h3>
              <p className="text-xs text-slate-600 max-w-md mx-auto">
                Our AI Agent Architect will analyze your business details, services, prices, and FAQs to generate a customized, structured AI receptionist configuration!
              </p>

              <button
                onClick={handleGenerateAgent}
                disabled={isGenerating}
                className="inline-flex items-center space-x-2 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white px-6 py-3 rounded-2xl font-semibold shadow-lg text-sm transition-all"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Analyzing & Generating Agent...</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    <span>Generate AI Agent Configuration</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Step 6: Review Suggested Config */}
          {step === 6 && generatedAgentConfig && (
            <div className="space-y-4">
              <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-xl flex items-center space-x-2 text-emerald-800 text-xs font-semibold">
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                <span>AI Agent Configuration Generated & Ready for Review!</span>
              </div>

              <div className="bg-slate-50 p-4 rounded-2xl border border-slate-200 space-y-3 text-xs">
                <div>
                  <span className="font-bold text-slate-900">Suggested Agent Name: </span>
                  <span className="text-blue-600 font-semibold">{generatedAgentConfig.agentName}</span>
                </div>

                <div>
                  <span className="font-bold text-slate-900 block mb-1">Generated System Instructions:</span>
                  <p className="bg-white p-3 rounded-xl border border-slate-200 text-slate-700 leading-relaxed font-mono text-[11px]">
                    {generatedAgentConfig.systemPrompt}
                  </p>
                </div>

                <div>
                  <span className="font-bold text-slate-900 block mb-1">Allowed Agent Tools:</span>
                  <div className="flex flex-wrap gap-1.5">
                    {(generatedAgentConfig.allowedActions || ['check_business_hours', 'check_availability', 'book_appointment']).map((tool: string) => (
                      <span key={tool} className="px-2 py-0.5 rounded bg-blue-100 text-blue-800 text-[10px] font-semibold">
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

        </div>

        {/* Modal Footer Controls */}
        <div className="bg-slate-50 p-4 border-t border-slate-200 flex items-center justify-between">
          <button
            onClick={() => setStep(Math.max(1, step - 1))}
            disabled={step === 1}
            className="px-4 py-2 text-xs font-semibold text-slate-600 hover:text-slate-900 disabled:opacity-40"
          >
            Back
          </button>

          {step < 5 && (
            <button
              onClick={() => setStep(step + 1)}
              className="flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-500 text-white px-5 py-2 rounded-xl text-xs font-semibold"
            >
              <span>Next Step</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}

          {step === 6 && (
            <button
              onClick={handleFinalize}
              className="flex items-center space-x-1.5 bg-emerald-600 hover:bg-emerald-500 text-white px-6 py-2.5 rounded-xl text-xs font-bold shadow-md"
            >
              <CheckCircle2 className="w-4 h-4" />
              <span>Deploy Business & Agent</span>
            </button>
          )}
        </div>

      </div>
    </div>
  );
};
