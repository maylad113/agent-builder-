import React, { useState } from 'react';
import { LogIn, Bot } from 'lucide-react';

interface LoginFormProps {
  onLogin: (user: any) => void;
}

const DEMO_ACCOUNTS = [
  { role: 'Platform Owner', email: 'owner@agentfactory.io', hint: 'All businesses' },
  { role: 'Business Owner', email: 'tony@tonysbarber.com', hint: "Tony's Barber Shop" },
  { role: 'Staff', email: 'staff@tonysbarber.com', hint: "Tony's Barber Shop" }
];

export const LoginForm: React.FC<LoginFormProps> = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Login failed. Please try again.');
        setSubmitting(false);
        return;
      }
      onLogin(data.user);
    } catch (err) {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-100/70 text-slate-900 font-sans antialiased flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="bg-white rounded-2xl shadow-xl border border-slate-200 p-8">
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-lg shadow-blue-500/20">
              <Bot className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold text-lg tracking-tight">AI Agent Factory</h1>
              <p className="text-xs text-slate-500">Sign in to your workspace</p>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Email</label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 mb-1.5">Password</label>
              <input
                type="password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                required
                placeholder="••••••••"
                className="w-full px-3.5 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            {error && (
              <div className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full flex items-center justify-center space-x-2 bg-gradient-to-r from-blue-600 to-indigo-500 hover:from-blue-500 hover:to-indigo-400 text-white text-sm font-semibold px-4 py-2.5 rounded-lg shadow-md transition-all active:scale-[0.98] disabled:opacity-60"
            >
              <LogIn className="w-4 h-4" />
              <span>{submitting ? 'Signing in…' : 'Sign In'}</span>
            </button>
          </form>
        </div>

        <div className="mt-4 bg-white rounded-xl border border-slate-200 p-4">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2">Demo accounts</p>
          <ul className="space-y-1.5">
            {DEMO_ACCOUNTS.map(a => (
              <li key={a.email} className="text-xs text-slate-600 flex items-center justify-between gap-2">
                <span>
                  <span className="font-semibold text-slate-700">{a.role}</span>
                  <span className="text-slate-400"> — {a.hint}</span>
                </span>
                <code className="text-[11px] bg-slate-100 rounded px-1.5 py-0.5">{a.email}</code>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-slate-400 mt-2">Password for all demo accounts: <code className="bg-slate-100 rounded px-1 py-0.5">Password123!</code></p>
        </div>
      </div>
    </div>
  );
};
