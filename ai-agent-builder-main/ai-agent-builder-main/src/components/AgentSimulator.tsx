import React, { useState } from 'react';
import { Agent, Business, ToolCallRecord } from '../types';
import { 
  Bot, 
  Send, 
  Code, 
  Clock, 
  Zap, 
  CheckCircle2, 
  AlertCircle, 
  ChevronRight, 
  Terminal, 
  Database, 
  Sparkles,
  User,
  RotateCcw
} from 'lucide-react';

interface AgentSimulatorProps {
  business: Business;
  agent: Agent;
}

interface DebugData {
  systemPrompt: string;
  retrievedKnowledge: string[];
  toolCalls: ToolCallRecord[];
  latencyMs: number;
  tokensUsed: number;
  model: string;
}

export const AgentSimulator: React.FC<AgentSimulatorProps> = ({
  business,
  agent
}) => {
  const [messages, setMessages] = useState<Array<{ sender: 'user' | 'agent'; text: string; tools?: ToolCallRecord[] }>>([
    {
      sender: 'agent',
      text: `Hello! I am ${agent.name} for ${business.name}. How can I assist you today? Feel free to ask about our services, opening hours, prices, or book an appointment!`
    }
  ]);

  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [lastDebug, setLastDebug] = useState<DebugData | null>(null);
  const [showDeveloperDrawer, setShowDeveloperDrawer] = useState(true);

  const handleSend = async () => {
    if (!inputMessage.trim() || loading) return;

    const userText = inputMessage.trim();
    setInputMessage('');
    setMessages(prev => [...prev, { sender: 'user', text: userText }]);
    setLoading(true);

    try {
      // The simulator is a developer tool and runs authenticated, so it uses
      // the /api/runtime/simulate endpoint which returns the developer-only
      // debug block (system prompt, retrieved knowledge, tool calls). The
      // public /api/runtime/chat endpoint (used by the embeddable widget)
      // intentionally strips that block.
      const res = await fetch('/api/runtime/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          businessId: business.id,
          userMessage: userText,
          channel: 'web_chat',
          // The simulator is internal (runs inside the authenticated
          // dashboard), so it may test a SPECIFIC agent — including one that
          // is still DRAFT/TESTING/READY and not yet ACTIVE. The server only
          // honors agentId for an authenticated session scoped to this tenant.
          agentId: agent.id
        })
      });

      const data = await res.json();

      setMessages(prev => [
        ...prev,
        {
          sender: 'agent',
          text: data.reply || "I'm sorry, I couldn't generate a response.",
          tools: data.debug?.toolCalls
        }
      ]);

      if (data.debug) {
        setLastDebug(data.debug);
      }
    } catch (err) {
      setMessages(prev => [
        ...prev,
        { sender: 'agent', text: "Connection error. Please try sending your message again." }
      ]);
    } finally {
      setLoading(false);
    }
  };

  const handleResetChat = () => {
    setMessages([
      {
        sender: 'agent',
        text: `Hello! I am ${agent.name} for ${business.name}. How can I assist you today?`
      }
    ]);
    setLastDebug(null);
  };

  return (
    <div className="space-y-4">
      
      {/* Header Bar */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div className="w-8 h-8 rounded-lg bg-blue-100 border border-blue-200 flex items-center justify-center text-blue-600">
            <Bot className="w-4 h-4" />
          </div>
          <div>
            <h3 className="font-bold text-slate-900 text-sm">Agent Simulator Sandbox</h3>
            <p className="text-[11px] text-slate-500">Test tool execution, RAG knowledge retrieval, and LLM behavior in real time.</p>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setShowDeveloperDrawer(!showDeveloperDrawer)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center space-x-1.5 transition-colors ${
              showDeveloperDrawer ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Code className="w-3.5 h-3.5" />
            <span>Developer Debug Drawer</span>
          </button>

          <button
            onClick={handleResetChat}
            className="p-1.5 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-lg text-xs"
            title="Reset Simulator Session"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Main Split Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[500px]">
        
        {/* Left Chat Frame (8 cols or 12) */}
        <div className={`${showDeveloperDrawer ? 'lg:col-span-7' : 'lg:col-span-12'} bg-white rounded-2xl border border-slate-200/80 shadow-sm flex flex-col overflow-hidden`}>
          
          {/* Chat Messages */}
          <div className="flex-1 p-4 space-y-3 overflow-y-auto max-h-[450px]">
            {messages.map((m, idx) => (
              <div key={idx} className={`flex flex-col ${m.sender === 'user' ? 'items-end' : 'items-start'}`}>
                
                <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-xs leading-relaxed ${
                  m.sender === 'user'
                    ? 'bg-blue-600 text-white rounded-br-none'
                    : 'bg-slate-100 text-slate-900 rounded-bl-none border border-slate-200/60'
                }`}>
                  <p>{m.text}</p>
                </div>

                {/* Inline Tool Execution Indicator */}
                {m.tools && m.tools.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1 max-w-[85%]">
                    {m.tools.map((t, tIdx) => (
                      <span key={tIdx} className="px-2 py-0.5 bg-amber-50 border border-amber-200 text-amber-800 text-[10px] font-semibold rounded flex items-center space-x-1">
                        <Terminal className="w-3 h-3 text-amber-600" />
                        <span>Executed: {t.toolName}()</span>
                      </span>
                    ))}
                  </div>
                )}

              </div>
            ))}

            {loading && (
              <div className="flex items-center space-x-2 text-slate-400 text-xs italic">
                <Bot className="w-4 h-4 animate-bounce text-blue-600" />
                <span>AI Agent is analyzing context and calling tools...</span>
              </div>
            )}
          </div>

          {/* Quick Prompts Bar */}
          <div className="px-4 py-2 bg-slate-50 border-t border-slate-100 flex flex-wrap gap-2 text-[11px]">
            <span className="text-slate-400 font-semibold">Test Prompts:</span>
            <button
              onClick={() => setInputMessage("Can I book a haircut tomorrow at 15:00?")}
              className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100"
            >
              "Book haircut tomorrow at 15:00"
            </button>
            <button
              onClick={() => setInputMessage("What are your services and prices?")}
              className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100"
            >
              "Services and prices?"
            </button>
            <button
              onClick={() => setInputMessage("Do you have any pomade or beard oil?")}
              className="bg-white px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-100"
            >
              "Search products"
            </button>
          </div>

          {/* Input Row */}
          <div className="p-3 border-t border-slate-200 flex items-center space-x-2 bg-white">
            <input
              type="text"
              placeholder="Type message to test AI agent..."
              value={inputMessage}
              onChange={(e) => setInputMessage(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSend()}
              className="flex-1 px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:border-blue-500"
            />
            <button
              onClick={handleSend}
              disabled={loading}
              className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-xl text-xs font-semibold flex items-center space-x-1.5 shadow-sm"
            >
              <span>Send</span>
              <Send className="w-3.5 h-3.5" />
            </button>
          </div>

        </div>

        {/* Right Developer Debug Drawer */}
        {showDeveloperDrawer && (
          <div className="lg:col-span-5 bg-slate-900 text-slate-200 rounded-2xl p-4 border border-slate-800 shadow-sm font-mono text-xs space-y-4 max-h-[500px] overflow-y-auto">
            
            <div className="flex items-center justify-between border-b border-slate-800 pb-2">
              <div className="flex items-center space-x-2 text-blue-400 font-bold">
                <Terminal className="w-4 h-4" />
                <span>Developer Debug Panel</span>
              </div>
              {lastDebug && (
                <div className="flex items-center space-x-2 text-[10px] text-slate-400">
                  <span className="text-emerald-400">{lastDebug.latencyMs}ms</span>
                  <span>•</span>
                  <span>~{lastDebug.tokensUsed} tokens</span>
                </div>
              )}
            </div>

            {lastDebug ? (
              <div className="space-y-4">
                
                {/* Tool Calls Log */}
                <div>
                  <span className="text-amber-400 font-bold text-[11px] block mb-1">
                    🔨 Tool Invocations ({lastDebug.toolCalls.length}):
                  </span>
                  {lastDebug.toolCalls.length > 0 ? (
                    <div className="space-y-2">
                      {lastDebug.toolCalls.map((t, idx) => (
                        <div key={idx} className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 space-y-1 text-[11px]">
                          <p className="text-blue-300 font-bold">{t.toolName}()</p>
                          <p className="text-slate-400">Args: {JSON.stringify(t.args)}</p>
                          <p className="text-emerald-400">Result: {JSON.stringify(t.result)}</p>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-slate-500 italic text-[11px]">No tools called in last turn.</p>
                  )}
                </div>

                {/* Retrieved RAG Context */}
                <div>
                  <span className="text-purple-400 font-bold text-[11px] block mb-1">
                    📚 Retrieved Knowledge (RAG):
                  </span>
                  {lastDebug.retrievedKnowledge.length > 0 ? (
                    <div className="space-y-1">
                      {lastDebug.retrievedKnowledge.map((k, idx) => (
                        <p key={idx} className="text-slate-300 bg-slate-950 p-2 rounded border border-slate-800 text-[10px]">
                          {k}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-slate-500 italic text-[11px]">No knowledge chunks retrieved.</p>
                  )}
                </div>

                {/* Full System Prompt */}
                <div>
                  <span className="text-blue-400 font-bold text-[11px] block mb-1">
                    🧠 Grounded System Prompt Preview:
                  </span>
                  <div className="bg-slate-950 p-2.5 rounded-xl border border-slate-800 max-h-36 overflow-y-auto text-[10px] text-slate-400 leading-relaxed">
                    {lastDebug.systemPrompt}
                  </div>
                </div>

              </div>
            ) : (
              <div className="text-center py-12 text-slate-500">
                <Terminal className="w-8 h-8 mx-auto mb-2 text-slate-700" />
                <p>Send a message in the simulator to view tool call execution, grounding context, and response latency.</p>
              </div>
            )}

          </div>
        )}

      </div>

    </div>
  );
};
