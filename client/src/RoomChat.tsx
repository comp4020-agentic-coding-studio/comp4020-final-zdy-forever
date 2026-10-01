import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { CHAT_MAX_LENGTH, type ChatMessage } from "../../shared/src/types.ts";

interface RoomChatProps {
  messages: ChatMessage[];
  accountId: string | null;
  connected: boolean;
  error: string | null;
  onSend: (text: string) => Promise<boolean>;
}

export function RoomChat({ messages, accountId, connected, error, onSend }: RoomChatProps) {
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastMessage = messages.at(-1);

  function scrollToLatest() {
    const feed = feedRef.current;
    if (!feed) return;
    followRef.current = true;
    feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
  }

  useLayoutEffect(() => {
    const feed = feedRef.current;
    if (feed && (followRef.current || lastMessage?.accountId === accountId)) {
      feed.scrollTop = feed.scrollHeight;
    }
  }, [lastMessage?.messageId, accountId]);

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!connected || sending || !draft.trim()) return;
    setSending(true);
    try {
      if (await onSend(draft)) {
        setDraft("");
        followRef.current = true;
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="card card--chat card--accent-orange">
      <div className="chat-heading">
        <h2>💬 Room chat</h2>
        <button
          type="button"
          className="btn btn--sm"
          disabled={messages.length === 0}
          aria-label="scroll the chat to the latest message"
          onClick={scrollToLatest}
        >
          📍 Latest message
        </button>
      </div>
      <div
        ref={feedRef}
        className="chat-feed"
        role="log"
        aria-label="Room messages"
        aria-live="polite"
        tabIndex={0}
        onScroll={() => {
          const feed = feedRef.current!;
          followRef.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
        }}
      >
        {messages.length === 0 && <p className="chat-empty">Say hello to the room 👋</p>}
        {messages.map((message) => (
          <div key={message.messageId} className={`chat-message${message.accountId === accountId ? " chat-message--self" : ""}`}>
            <div className="chat-message-meta">
              <strong>{message.displayName}{message.accountId === accountId ? " (you)" : ""}</strong>
              <time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>
                {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </time>
            </div>
            <p>{message.text}</p>
          </div>
        ))}
      </div>
      <form className="chat-form" onSubmit={send}>
        <div className="chat-input-wrap">
          <textarea
            id="chat-message"
            aria-label="Message"
            value={draft}
            maxLength={CHAT_MAX_LENGTH}
            rows={2}
            placeholder={connected ? "Chat with everyone in this room… Shift+Enter for a new line" : "Reconnecting…"}
            disabled={!connected || sending}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            aria-describedby="chat-count"
          />
        </div>
        <div className="chat-send-column">
          <small id="chat-count" className="chat-count" aria-label={`${draft.length} characters`}>
            {draft.length > 999 ? "999+" : draft.length}
          </small>
          <button className="btn btn--yellow chat-send" type="submit" disabled={!connected || sending || !draft.trim()}>
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
        {error && <p role="alert">{error}</p>}
      </form>
    </div>
  );
}
