import React, { useState } from 'react';
import { Business } from '../types';
import { Code, Copy, Check, ExternalLink, Sparkles, Smartphone, Monitor } from 'lucide-react';

interface WebsiteChatWidgetDemoProps {
  business: Business;
}

export const WebsiteChatWidgetDemo: React.FC<WebsiteChatWidgetDemoProps> = ({
  business
}) => {
  const [copied, setCopied] = useState(false);
  const [widgetColor, setWidgetColor] = useState('#2563eb');

  const snippetCode = `<!-- AI Agent Factory Embeddable Receptionist Widget -->
<script 
  src="${window.location.origin}/widget.js" 
  data-business-id="${business.id}" 
  data-color="${widgetColor}">
</script>`;

  const handleCopy = () => {
    navigator.clipboard.writeText(snippetCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="space-y-6">
      
      {/* Overview Banner */}
      <div className="bg-white p-6 rounded-2xl border border-slate-200/80 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900">Embeddable Website Chat Widget</h2>
          <p className="text-xs text-slate-500 mt-1">
            Embed your AI receptionist directly on {business.name}'s website with a single line of JavaScript.
          </p>
        </div>

        <div className="flex items-center space-x-3">
          <label className="text-xs font-semibold text-slate-700">Brand Color:</label>
          <input
            type="color"
            value={widgetColor}
            onChange={(e) => setWidgetColor(e.target.value)}
            className="w-8 h-8 rounded-lg cursor-pointer border border-slate-200 p-0.5"
          />
        </div>
      </div>

      {/* Code Snippet Box */}
      <div className="bg-slate-900 rounded-2xl p-6 text-slate-100 border border-slate-800 shadow-lg space-y-3 font-mono text-xs">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <div className="flex items-center space-x-2 text-blue-400 font-bold">
            <Code className="w-4 h-4" />
            <span>Website Integration Snippet</span>
          </div>

          <button
            onClick={handleCopy}
            className="flex items-center space-x-1.5 bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg text-xs font-sans font-semibold transition-all"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-300" /> : <Copy className="w-3.5 h-3.5" />}
            <span>{copied ? 'Copied!' : 'Copy Snippet'}</span>
          </button>
        </div>

        <pre className="text-blue-300 bg-slate-950 p-4 rounded-xl border border-slate-800 overflow-x-auto leading-relaxed">
          {snippetCode}
        </pre>
      </div>

      {/* Interactive Mock Local Business Website Preview */}
      <div className="bg-slate-100 rounded-2xl border border-slate-300 p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-slate-900 text-sm flex items-center space-x-2">
            <Monitor className="w-4 h-4 text-slate-700" />
            <span>Live Customer Website Preview ({business.name})</span>
          </h3>
          <span className="text-xs text-slate-500">The floating widget button appears at bottom right.</span>
        </div>

        {/* Fake Local Business Webpage */}
        <div className="bg-white rounded-xl border border-slate-200 p-8 shadow-sm relative min-h-[350px] flex flex-col justify-between">
          
          <div className="space-y-4">
            <div className="flex items-center justify-between border-b border-slate-100 pb-4">
              <span className="text-lg font-black tracking-tight text-slate-900">{business.name}</span>
              <div className="space-x-4 text-xs font-semibold text-slate-600">
                <span>Services</span>
                <span>Hours</span>
                <span>Contact</span>
              </div>
            </div>

            <div className="py-8 text-center space-y-2">
              <h1 className="text-2xl font-extrabold text-slate-900">{business.name}</h1>
              <p className="text-xs text-slate-500 max-w-md mx-auto">{business.description}</p>
              <p className="text-xs font-bold text-blue-600">📍 {business.location}</p>
            </div>
          </div>

          {/* Rendered Live Floating Widget Button Demo */}
          <div className="absolute bottom-6 right-6">
            <div 
              className="w-14 h-14 rounded-full text-white shadow-xl flex items-center justify-center cursor-pointer hover:scale-105 transition-transform"
              style={{ backgroundColor: widgetColor }}
            >
              <Sparkles className="w-6 h-6" />
            </div>
          </div>

        </div>
      </div>

    </div>
  );
};
