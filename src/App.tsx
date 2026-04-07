/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { vault } from './lib/obsidian';
import { sendMessage, Message, ChatSession } from './lib/gemini';
import { FolderOpen, Send, FileText, Bot, User, Loader2, Plus, MessageSquare, Trash2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { v4 as uuidv4 } from 'uuid';

export default function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [templates, setTemplates] = useState<string[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  
  const [chats, setChats] = useState<ChatSession[]>(() => {
    const saved = localStorage.getItem('obsidian-ai-chats');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved chats", e);
      }
    }
    return [];
  });
  
  const [activeChatId, setActiveChatId] = useState<string | null>(() => {
    const saved = localStorage.getItem('obsidian-ai-chats');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed.length > 0) return parsed[0].id;
      } catch (e) {}
    }
    return null;
  });
  
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  
  // Autocomplete state
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [autocompleteFilter, setAutocompleteFilter] = useState('');
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  const activeChat = chats.find(c => c.id === activeChatId);

  // Load persisted vault on mount
  useEffect(() => {
    const init = async () => {
      const success = await vault.loadPersisted();
      if (success) {
        setIsConnected(true);
        setTemplates(Object.keys(vault.templates));
      }
    };
    init();
  }, []);

  // Save chats to local storage whenever they change
  useEffect(() => {
    localStorage.setItem('obsidian-ai-chats', JSON.stringify(chats));
  }, [chats]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [activeChat?.messages]);

  const handleConnect = async () => {
    const success = await vault.connect();
    if (success) {
      setIsConnected(true);
      setTemplates(Object.keys(vault.templates));
      if (chats.length === 0) {
        createNewChat();
      }
    }
  };

  const createNewChat = () => {
    const newChat: ChatSession = {
      id: uuidv4(),
      title: 'New Chat',
      messages: [{ role: 'model', text: 'Vault connected! How can I help you build your world today?' }],
      history: []
    };
    setChats(prev => [newChat, ...prev]);
    setActiveChatId(newChat.id);
  };

  const deleteChat = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setChats(prev => prev.filter(c => c.id !== id));
    if (activeChatId === id) {
      setActiveChatId(chats.find(c => c.id !== id)?.id || null);
    }
  };

  const updateActiveChat = (updates: Partial<ChatSession>) => {
    setChats(prev => prev.map(c => c.id === activeChatId ? { ...c, ...updates } : c));
  };

  const handleSend = async () => {
    if (!input.trim() || isLoading || !activeChatId || !activeChat) return;
    
    const userText = input.trim();
    setInput('');
    setIsLoading(true);

    // Update title if it's the first user message
    if (activeChat.messages.length === 1 && activeChat.title === 'New Chat') {
      updateActiveChat({ title: userText.slice(0, 30) + (userText.length > 30 ? '...' : '') });
    }

    const newMessages = [...activeChat.messages, { role: 'user' as const, text: userText }];
    updateActiveChat({ messages: newMessages });

    let currentModelMessageIndex = -1;

    const result = await sendMessage(userText, selectedTemplate || null, activeChat.history, (msg) => {
      setChats(prev => prev.map(c => {
        if (c.id !== activeChatId) return c;
        
        const updatedMessages = [...c.messages];
        if (msg.role === 'user') return c; // Already added optimistically
        
        if (currentModelMessageIndex === -1) {
          currentModelMessageIndex = updatedMessages.length;
          updatedMessages.push(msg);
        } else {
          updatedMessages[currentModelMessageIndex] = msg;
        }
        return { ...c, messages: updatedMessages };
      }));
    });

    updateActiveChat({ history: result.history });
    setIsLoading(false);
  };

  // Autocomplete logic
  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);

    // Check for quotes
    const cursorPosition = e.target.selectionStart;
    const textBeforeCursor = val.slice(0, cursorPosition);
    
    // Match the last quote that isn't closed before the cursor
    const match = textBeforeCursor.match(/"([^"]*)$/);
    
    if (match) {
      setShowAutocomplete(true);
      setAutocompleteFilter(match[1].toLowerCase());
      setAutocompleteIndex(0);
    } else {
      setShowAutocomplete(false);
    }

    // Auto-resize
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  const filteredNotes = vault.files
    .map(f => f.split('/').pop()?.replace('.md', '') || f)
    .filter(name => name.toLowerCase().includes(autocompleteFilter))
    .slice(0, 5);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showAutocomplete && filteredNotes.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAutocompleteIndex(prev => (prev + 1) % filteredNotes.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAutocompleteIndex(prev => (prev - 1 + filteredNotes.length) % filteredNotes.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertAutocomplete(filteredNotes[autocompleteIndex]);
        return;
      }
      if (e.key === 'Escape') {
        setShowAutocomplete(false);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey && !showAutocomplete) {
      e.preventDefault();
      handleSend();
    }
  };

  const insertAutocomplete = (noteName: string) => {
    if (!textareaRef.current) return;
    const cursorPosition = textareaRef.current.selectionStart;
    const textBeforeCursor = input.slice(0, cursorPosition);
    const textAfterCursor = input.slice(cursorPosition);
    
    const lastQuoteIndex = textBeforeCursor.lastIndexOf('"');
    if (lastQuoteIndex !== -1) {
      const newTextBefore = textBeforeCursor.slice(0, lastQuoteIndex) + `"${noteName}"`;
      setInput(newTextBefore + textAfterCursor);
      setShowAutocomplete(false);
      
      // Reset height
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
          textareaRef.current.focus();
          textareaRef.current.setSelectionRange(newTextBefore.length, newTextBefore.length);
        }
      }, 0);
    }
  };

  return (
    <div className="flex h-screen bg-gray-50 text-gray-900 font-sans">
      {/* Sidebar */}
      <div className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-200">
          <h1 className="text-xl font-bold flex items-center gap-2 text-indigo-600">
            <Bot size={24} />
            Obsidian AI
          </h1>
        </div>
        
        <div className="p-4 flex-1 overflow-y-auto flex flex-col gap-6">
          {!isConnected ? (
            <div className="text-center mt-10">
              <FolderOpen className="mx-auto text-gray-400 mb-4" size={48} />
              <p className="text-sm text-gray-600 mb-4">Connect your Obsidian vault to get started.</p>
              <button 
                onClick={handleConnect}
                className="bg-indigo-600 text-white px-4 py-2 rounded-md hover:bg-indigo-700 transition-colors w-full flex items-center justify-center gap-2"
              >
                <FolderOpen size={18} />
                Open Vault
              </button>
            </div>
          ) : (
            <>
              <div>
                <div className="flex items-center gap-2 text-green-600 mb-2">
                  <div className="w-2 h-2 rounded-full bg-green-500"></div>
                  <span className="text-sm font-medium">Vault Connected</span>
                </div>
                <p className="text-xs text-gray-500">{vault.files.length} files loaded</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2 flex items-center gap-2">
                  <FileText size={16} />
                  Primary Template
                </label>
                <select 
                  value={selectedTemplate}
                  onChange={(e) => setSelectedTemplate(e.target.value)}
                  className="w-full border border-gray-300 rounded-md shadow-sm py-2 px-3 focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm bg-white"
                >
                  <option value="">None</option>
                  {templates.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>

              <div className="flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-2">
                  <label className="block text-sm font-medium text-gray-700">Chats</label>
                  <button onClick={createNewChat} className="text-indigo-600 hover:text-indigo-800 p-1 rounded hover:bg-indigo-50">
                    <Plus size={16} />
                  </button>
                </div>
                <div className="flex-1 overflow-y-auto space-y-1">
                  {chats.map(chat => (
                    <div 
                      key={chat.id}
                      onClick={() => setActiveChatId(chat.id)}
                      className={`w-full text-left px-3 py-2 rounded-md text-sm flex items-center justify-between group cursor-pointer ${activeChatId === chat.id ? 'bg-indigo-50 text-indigo-700 font-medium' : 'text-gray-600 hover:bg-gray-100'}`}
                    >
                      <div className="flex items-center gap-2 overflow-hidden">
                        <MessageSquare size={14} className="flex-shrink-0" />
                        <span className="truncate">{chat.title}</span>
                      </div>
                      <button 
                        onClick={(e) => deleteChat(chat.id, e)}
                        className="text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-gray-50 relative">
        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {!isConnected ? (
            <div className="h-full flex items-center justify-center text-gray-400">
              Please connect your vault to start chatting.
            </div>
          ) : !activeChat ? (
            <div className="h-full flex items-center justify-center text-gray-400">
              Select or create a chat to begin.
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-6">
              {activeChat.messages.map((msg, idx) => (
                <div key={idx} className={`flex gap-4 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'model' && (
                    <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 mt-1">
                      <Bot size={18} className="text-indigo-600" />
                    </div>
                  )}
                  <div className={`max-w-[80%] rounded-2xl px-5 py-4 ${
                    msg.role === 'user' 
                      ? 'bg-indigo-600 text-white rounded-tr-sm' 
                      : 'bg-white border border-gray-200 shadow-sm rounded-tl-sm text-gray-800'
                  }`}>
                    {msg.role === 'user' ? (
                      <p className="whitespace-pre-wrap">{msg.text}</p>
                    ) : (
                      <div className="markdown-body prose prose-sm max-w-none">
                        <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                      </div>
                    )}
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0 mt-1">
                      <User size={18} className="text-gray-600" />
                    </div>
                  )}
                </div>
              ))}
              {isLoading && (
                <div className="flex gap-4 justify-start">
                  <div className="w-8 h-8 rounded-full bg-indigo-100 flex items-center justify-center flex-shrink-0 mt-1">
                    <Bot size={18} className="text-indigo-600" />
                  </div>
                  <div className="bg-white border border-gray-200 shadow-sm rounded-2xl rounded-tl-sm px-5 py-4 flex items-center gap-2 text-gray-500">
                    <Loader2 size={16} className="animate-spin" />
                    Thinking...
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-4 bg-white border-t border-gray-200 relative">
          <div className="max-w-3xl mx-auto relative">
            
            {/* Autocomplete Dropdown */}
            {showAutocomplete && filteredNotes.length > 0 && (
              <div className="absolute bottom-full mb-2 left-0 w-64 bg-white border border-gray-200 shadow-lg rounded-lg overflow-hidden z-10">
                {filteredNotes.map((note, idx) => (
                  <div 
                    key={note}
                    onClick={() => insertAutocomplete(note)}
                    className={`px-4 py-2 text-sm cursor-pointer ${idx === autocompleteIndex ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-50'}`}
                  >
                    {note}
                  </div>
                ))}
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={input}
              onChange={handleInput}
              onKeyDown={handleKeyDown}
              placeholder={isConnected ? 'Type " to mention a note...' : "Connect vault to type..."}
              disabled={!isConnected || isLoading || !activeChatId}
              className="w-full border border-gray-300 rounded-xl pl-4 pr-12 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none disabled:bg-gray-50 disabled:text-gray-400"
              rows={1}
              style={{ minHeight: '52px', maxHeight: '200px' }}
            />
            <button
              onClick={handleSend}
              disabled={!isConnected || !input.trim() || isLoading || !activeChatId}
              className="absolute right-2 bottom-2 p-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
            >
              <Send size={18} />
            </button>
          </div>
          <div className="max-w-3xl mx-auto mt-2 text-center">
            <p className="text-xs text-gray-400">
              Press Enter to send, Shift+Enter for new line. Type " to autocomplete note names.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
