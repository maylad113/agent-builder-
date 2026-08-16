import React, { useState, useEffect } from 'react';
import { Conversation, Message, Business } from '../types';
import { 
  MessageSquare, 
  UserCheck, 
  Send, 
  CheckCircle2, 
  AlertCircle, 
  User, 
  Bot, 
  Clock, 
  Phone, 
  ShieldAlert,
  Search
} from 'lucide-react';

interface ConversationsViewProps {
  business: Business;
}

export const ConversationsView: React.FC<ConversationsViewProps> = ({
  business
}) => {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [replyInput, setReplyInput] = useState('');
  const [loading, setLoading] = useState(false);

  const fetchConversations = async () => {
    try {
      const res = await fetch(`/api/conversations?businessId=${business.id}`);
      const data = await res.json();
      setConversations(data);
      if (data.length > 0 && !selectedConvId) {
        setSelectedConvId(data[0].id);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchMessages = async (convId: string) => {
    try {
      const res = await fetch(`/api/conversations/${convId}/messages`);
      const data = await res.json();
      setMessages(data);
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchConversations();
    const interval = setInterval(fetchConversations, 5000); // Polling for new chats
    return () => clearInterval(interval);
  }, [business.id]);

  useEffect(() => {
    if (selectedConvId) {
      fetchMessages(selectedConvId);
    }
  }, [selectedConvId]);

  const activeConv = conversations.find(c => c.id === selectedConvId);

  const handleTakeover = async () => {
    if (!selectedConvId) return;
    try {
      const res = await fetch(`/api/conversations/${selectedConvId}/takeover`, { method: 'POST' });
      if (res.ok) {
        fetchConversations();
        fetchMessages(selectedConvId);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleResolve = async () => {
    if (!selectedConvId) return;
    try {
      const res = await fetch(`/api/conversations/${selectedConvId}/resolve`, { method: 'POST' });
      if (res.ok) {
        fetchConversations();
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSendHumanMessage = async () => {
    if (!selectedConvId || !replyInput.trim()) return;
    try {
      const res = await fetch(`/api/conversations/${selectedConvId}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: replyInput.trim() })
      });
      if (res.ok) {
        setReplyInput('');
        fetchMessages(selectedConvId);
      }
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="space-y-4">
      
      {/* Header */}
      <div className="bg-white p-4 rounded-2xl border border-slate-200/80 shadow-sm flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-slate-900">Conversations & Human Handoff Center</h2>
          <p className="text-xs text-slate-500">Monitor live AI chats and take over whenever a customer requires human intervention.</p>
        </div>
      </div>

      {/* Main Split Interface */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-[500px]">
        
        {/* Left Conversations List (4 Cols) */}
        <div className="lg:col-span-4 bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden flex flex-col">
          <div className="p-3 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-700">
            Active Chats ({conversations.length})
          </div>

          <div className="divide-y divide-slate-100 overflow-y-auto flex-1 max-h-[480px]">
            {conversations.map(conv => (
              <button
                key={conv.id}
                onClick={() => setSelectedConvId(conv.id)}
                className={`w-full p-3 text-left transition-colors flex flex-col space-y-1.5 ${
                  selectedConvId === conv.id ? 'bg-blue-50/80 border-l-4 border-blue-600' : 'hover:bg-slate-50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-bold text-xs text-slate-900">{conv.customerName}</span>
                  <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full uppercase ${
                    conv.status === 'WAITING_FOR_HUMAN' ? 'bg-red-100 text-red-800 animate-pulse' :
                    conv.status === 'HUMAN_HANDLING' ? 'bg-purple-100 text-purple-800' :
                    conv.status === 'RESOLVED' ? 'bg-slate-100 text-slate-600' :
                    'bg-blue-100 text-blue-800'
                  }`}>
                    {conv.status.replace(/_/g, ' ')}
                  </span>
                </div>

                <p className="text-[11px] text-slate-500 line-clamp-1">{conv.summary || 'Chat active'}</p>
                <div className="flex items-center justify-between text-[10px] text-slate-400">
                  <span>Channel: {conv.channel}</span>
                  <span>{new Date(conv.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Right Message Chat Detail (8 Cols) */}
        <div className="lg:col-span-8 bg-white rounded-2xl border border-slate-200/80 shadow-sm overflow-hidden flex flex-col">
          
          {activeConv ? (
            <>
              {/* Chat Header Bar */}
              <div className="p-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <div className="flex items-center space-x-2">
                    <span className="font-bold text-slate-900 text-sm">{activeConv.customerName}</span>
                    <span className="text-xs text-slate-500">({activeConv.customerPhone || 'Web Guest'})</span>
                  </div>
                  <p className="text-[11px] text-slate-500">Status: {activeConv.status}</p>
                </div>

                <div className="flex items-center space-x-2">
                  {activeConv.status !== 'HUMAN_HANDLING' && activeConv.status !== 'RESOLVED' && (
                    <button
                      onClick={handleTakeover}
                      className="bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-sm flex items-center space-x-1"
                    >
                      <UserCheck className="w-3.5 h-3.5" />
                      <span>Take Over Chat</span>
                    </button>
                  )}

                  {activeConv.status !== 'RESOLVED' && (
                    <button
                      onClick={handleResolve}
                      className="bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold px-3 py-1.5 rounded-lg shadow-sm flex items-center space-x-1"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Mark Resolved</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Message Feed */}
              <div className="flex-1 p-4 space-y-3 overflow-y-auto max-h-[380px] bg-slate-50/50">
                {messages.map(m => (
                  <div
                    key={m.id}
                    className={`flex flex-col ${
                      m.sender === 'customer' ? 'items-start' : 'items-end'
                    }`}
                  >
                    <div className="flex items-center space-x-1 text-[10px] text-slate-400 mb-0.5">
                      <span className="capitalize font-semibold">{m.sender.replace(/_/g, ' ')}</span>
                      <span>• {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>

                    <div className={`max-w-[80%] p-3 rounded-2xl text-xs leading-relaxed ${
                      m.sender === 'customer' ? 'bg-white border border-slate-200 text-slate-900' :
                      m.sender === 'human_agent' ? 'bg-purple-600 text-white' :
                      m.sender === 'system' ? 'bg-amber-100 text-amber-900 text-center text-[11px] italic' :
                      'bg-blue-600 text-white'
                    }`}>
                      {m.content}
                    </div>
                  </div>
                ))}
              </div>

              {/* Human Reply Input Bar */}
              <div className="p-3 bg-white border-t border-slate-200 flex items-center space-x-2">
                <input
                  type="text"
                  placeholder={
                    activeConv.status === 'HUMAN_HANDLING'
                      ? 'Type human response to customer...'
                      : 'Take over chat to reply as human...'
                  }
                  value={replyInput}
                  disabled={activeConv.status !== 'HUMAN_HANDLING'}
                  onChange={(e) => setReplyInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendHumanMessage()}
                  className="flex-1 px-4 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-900 focus:outline-none focus:border-purple-500 disabled:opacity-50"
                />
                <button
                  onClick={handleSendHumanMessage}
                  disabled={activeConv.status !== 'HUMAN_HANDLING' || !replyInput.trim()}
                  className="bg-purple-600 hover:bg-purple-500 text-white px-4 py-2 rounded-xl text-xs font-semibold flex items-center space-x-1 disabled:opacity-50"
                >
                  <span>Send</span>
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>

            </>
          ) : (
            <div className="flex items-center justify-center flex-1 text-slate-400 text-xs">
              Select a conversation to view chat history and take over.
            </div>
          )}

        </div>

      </div>

    </div>
  );
};
