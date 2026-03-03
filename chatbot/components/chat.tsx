"use client";

import { useChat } from "@ai-sdk/react";
import { useRef, useState, useEffect } from "react";
import { Message } from "./message";
import { SettingsBar, type ChatSettings } from "./settings-bar";

export function Chat() {
  const [settings, setSettings] = useState<ChatSettings>({
    routingMode: "ai_core",
    modelFamily: "openai",
    tradition: "",
    model: "gloo-openai-gpt-5-mini",
  });

  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { messages, status, error, sendMessage, stop } = useChat();

  const isStreaming = status === "streaming" || status === "submitted";

  // Auto-scroll to bottom on new content
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming) return;
    setInput("");
    sendMessage(
      { text },
      {
        body: {
          routingMode: settings.routingMode,
          modelFamily: settings.modelFamily,
          tradition: settings.tradition || undefined,
          model: settings.model,
        },
      }
    );
  };

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col gap-4 p-4">
      <header className="flex-none">
        <h1 className="text-xl font-semibold">Gloo AI Chatbot</h1>
        <p className="text-sm text-gray-500">
          Streaming markdown via Completions V2
        </p>
      </header>

      <SettingsBar settings={settings} onChange={setSettings} />

      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
          {error.message}
        </div>
      )}

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto">
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center text-gray-400">
            Send a message to get started
          </div>
        )}
        {messages.map((message, index) => (
          <Message
            key={message.id}
            message={message}
            isStreaming={
              isStreaming &&
              index === messages.length - 1 &&
              message.role === "assistant"
            }
          />
        ))}
      </div>

      <form onSubmit={handleSubmit} className="flex flex-none gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type a message..."
          className="flex-1 rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          disabled={isStreaming}
        />
        {isStreaming ? (
          <button
            type="button"
            onClick={stop}
            className="rounded-xl bg-gray-600 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-gray-700"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim()}
            className="rounded-xl bg-blue-600 px-5 py-3 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            Send
          </button>
        )}
      </form>
    </div>
  );
}
