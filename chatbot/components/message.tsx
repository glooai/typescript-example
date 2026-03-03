"use client";

import type { UIMessage } from "ai";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";

const plugins = { code };

export function Message({
  message,
  isStreaming,
}: {
  message: UIMessage;
  isStreaming: boolean;
}) {
  const isUser = message.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[80%] rounded-2xl px-4 py-3 ${
          isUser
            ? "bg-blue-600 text-white"
            : "bg-white shadow-sm border border-gray-200"
        }`}
      >
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            if (isUser) {
              return (
                <p key={i} className="whitespace-pre-wrap">
                  {part.text}
                </p>
              );
            }
            return (
              <Streamdown
                key={`${message.id}-${i}`}
                plugins={plugins}
                isAnimating={isStreaming}
              >
                {part.text}
              </Streamdown>
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
