"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Check, CheckCheck, ChevronDown, Clock3, Flag, Inbox, LoaderCircle, LockKeyhole, MessageCircle, Plus, Search, Send, ShieldCheck, X } from "lucide-react";
import type { AppState, SupportMessage, SupportThread } from "@/lib/event-types";
import "./messages-center.css";

type Props = {
  data: AppState;
  act: (payload: Record<string, unknown>, success?: string) => Promise<boolean>;
  busy: boolean;
  admin?: boolean;
  initialEventId?: string | null;
};
type ThreadStatus = "open" | "in_progress" | "resolved";
type HistoryPage = { messages: SupportMessage[]; hasMore: boolean; nextCursor: string | null; error?: string };
type ThreadPage = { items: SupportThread[]; total: number; page: number; pageSize: number };
function mergeMessages(older: SupportMessage[], newer: SupportMessage[]) {
  return [...new Map([...older, ...newer].map(message => [message.id, message])).values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
const labels: Record<ThreadStatus, string> = { open: "Открыто", in_progress: "В работе", resolved: "Решено" };
const fullDate = (value: string) => new Date(value).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Yekaterinburg" });
const shortDate = (value: string) => new Date(value).toLocaleDateString("ru-RU", { day: "numeric", month: "short", timeZone: "Asia/Yekaterinburg" });

export function MessagesCenter({ data, act, busy, admin = false, initialEventId }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [threadPage, setThreadPage] = useState(1);
  const [remoteThreads, setRemoteThreads] = useState<(ThreadPage & { key: string; filterKey: string }) | null>(null);
  const [threadCache, setThreadCache] = useState<Record<string, SupportThread>>({});
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [listRevision, setListRevision] = useState(0);
  const [threadError, setThreadError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);
  const [subject, setSubject] = useState("");
  const [firstMessage, setFirstMessage] = useState("");
  const [eventId, setEventId] = useState("");
  const [internal, setInternal] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [readFailed, setReadFailed] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const [history, setHistory] = useState<Record<string, HistoryPage>>({});
  const [loadingHistory, setLoadingHistory] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inboxRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const consumedEvent = useRef<string | null>(null);
  const readAttempt = useRef("");
  const creating = useRef<Set<string> | null>(null);
  const latestAct = useRef(act);
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const historyInFlight = useRef(false);
  const scrollAnchor = useRef<{ threadId: string; height: number; top: number } | null>(null);
  latestAct.current = act;

  const listKey = `${admin ? "admin" : "own"}|${threadPage}|${filter}|${debouncedQuery}`;
  const listFilterKey = `${admin ? "admin" : "own"}|${filter}|${debouncedQuery}`;
  const currentList = remoteThreads?.key === listKey ? remoteThreads : null;
  const totalThreads = remoteThreads?.filterKey === listFilterKey ? remoteThreads.total : null;
  const threads = currentList?.items || [];
  const selected = selectedId ? threadCache[selectedId] : undefined;
  const unread = threads.reduce((total, thread) => total + thread.unreadCount, 0);
  const openCount = threads.filter(thread => thread.status !== "resolved").length;
  const totalPages = Math.max(1, Math.ceil((totalThreads || 0) / 20));
  const draftKey = `${selectedId || ""}:${internal ? "internal" : "reply"}`;
  const reply = drafts[draftKey] || "";
  const selectedHistory = selectedId ? history[selectedId] : undefined;
  const messages = mergeMessages(selectedHistory?.messages || [], selected?.messages || []).filter(message => admin || !message.internal);
  const hasEarlierMessages = selectedHistory?.hasMore ?? selected?.hasEarlierMessages ?? false;
  const lastMessageId = messages.at(-1)?.id;
  const canCreate = data.settings.supportEnabled || data.user.isAdmin;
  const prizeEvents = data.events.filter(event => event.winnerUserId === data.user.id && event.status === "completed");

  useEffect(() => {
    const timer = window.setTimeout(() => { setDebouncedQuery(query.trim()); setThreadPage(1); }, 300);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const visible = data.supportThreads.filter(thread => admin || thread.userId === data.user.id);
    setThreadCache(previous => {
      const updated = { ...previous };
      for (const thread of visible) if (!updated[thread.id] || thread.updatedAt >= updated[thread.id].updatedAt) updated[thread.id] = thread;
      return updated;
    });
  }, [data.supportThreads, data.user.id, admin]);

  useEffect(() => {
    const controller = new AbortController();
    setListLoading(true); setListError("");
    const params = new URLSearchParams({ page: String(threadPage), pageSize: "20", query: debouncedQuery, status: filter, scope: admin ? "admin" : "own" });
    void (async () => {
      try {
        const response = await fetch(`/api/support-threads?${params}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json() as ThreadPage & { error?: string };
        if (!response.ok) throw new Error(result.error || "Не удалось загрузить обращения.");
        if (!Array.isArray(result.items) || !Number.isFinite(result.total)) throw new Error("Некорректный ответ сервера.");
        if (controller.signal.aborted) return;
        setRemoteThreads({ ...result, key: listKey, filterKey: listFilterKey });
        setThreadCache(previous => ({ ...previous, ...Object.fromEntries(result.items.map(thread => [thread.id, thread])) }));
        const lastPage = Math.max(1, Math.ceil(result.total / 20));
        if (threadPage > lastPage) setThreadPage(lastPage);
      } catch (error) { if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : "Не удалось загрузить обращения."); }
      finally { if (!controller.signal.aborted) setListLoading(false); }
    })();
    return () => controller.abort();
  }, [listKey, listFilterKey, threadPage, filter, debouncedQuery, admin, data.supportThreads, listRevision]);

  useEffect(() => {
    if (!selectedId) return;
    const controller = new AbortController();
    setThreadError("");
    const params = new URLSearchParams({ threadId: selectedId, scope: admin ? "admin" : "own", pageSize: "20", page: "1" });
    void (async () => {
      try {
        const response = await fetch(`/api/support-threads?${params}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json() as ThreadPage & { error?: string };
        if (!response.ok) throw new Error(result.error || "Не удалось обновить переписку.");
        const thread = result.items?.find(item => item.id === selectedId);
        if (!thread) throw new Error("Переписка недоступна. Обновите список обращений.");
        if (!controller.signal.aborted) setThreadCache(previous => ({ ...previous, [thread.id]: thread }));
      } catch (error) { if (!controller.signal.aborted) setThreadError(error instanceof Error ? error.message : "Не удалось обновить переписку."); }
    })();
    return () => controller.abort();
  }, [selectedId, admin, data.supportThreads, listRevision]);

  useEffect(() => { if (inboxRef.current) inboxRef.current.scrollTop = 0; }, [threadPage, filter, debouncedQuery]);

  useEffect(() => {
    if (!selected) return;
    setHistory(previous => {
      const existing = previous[selected.id];
      const combined = mergeMessages(existing?.messages || [], selected.messages);
      if (existing && combined.length === existing.messages.length && combined.every((message, index) => message.id === existing.messages[index].id && message.body === existing.messages[index].body)) return previous;
      return { ...previous, [selected.id]: { messages: combined, hasMore: existing?.hasMore ?? selected.hasEarlierMessages, nextCursor: existing ? existing.nextCursor : selected.historyCursor, error: existing?.error } };
    });
  }, [selected?.id, selected?.messages]);

  useLayoutEffect(() => {
    const anchor = scrollAnchor.current;
    const list = listRef.current;
    if (anchor && list && anchor.threadId === selectedId) {
      list.scrollTop = anchor.top + list.scrollHeight - anchor.height;
      scrollAnchor.current = null;
    }
  }, [selectedHistory?.messages, selectedId]);

  useEffect(() => {
    if (initialEventId && consumedEvent.current !== initialEventId) {
      consumedEvent.current = initialEventId;
      const existing = data.supportThreads.find(thread => thread.eventId === initialEventId && thread.userId === data.user.id);
      if (existing) { setSelectedId(existing.id); setComposing(false); }
      else {
        setEventId(initialEventId);
        setSubject(`Вопрос по призу: ${data.events.find(event => event.id === initialEventId)?.title || "розыгрыш"}`.slice(0, 100));
        setComposing(true);
        setSelectedId(null);
      }
    }
  }, [initialEventId, data.supportThreads, data.events, data.user.id]);

  useEffect(() => {
    if (creating.current) {
      const created = data.supportThreads.find(thread => thread.userId === data.user.id && !creating.current!.has(thread.id));
      if (created) { setSelectedId(created.id); setComposing(false); creating.current = null; }
    }
  }, [data.supportThreads, data.user.id]);

  useEffect(() => {
    if (!selected || composing || busy || !selected.unreadCount || document.hidden) return;
    const key = `${selected.id}:${selected.updatedAt}:${selected.unreadCount}`;
    if (readAttempt.current === key) return;
    readAttempt.current = key;
    void latestAct.current({ kind: "readThread", threadId: selected.id, readThrough: selected.updatedAt }).then(succeeded => setReadFailed(!succeeded));
  }, [selected?.id, selected?.updatedAt, selected?.unreadCount, busy, composing, readRevision]);

  useEffect(() => {
    const onVisibility = () => { if (!document.hidden) { readAttempt.current = ""; setReadRevision(value => value + 1); } };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (list && isAtBottom) list.scrollTop = list.scrollHeight;
  }, [lastMessageId, selectedId, isAtBottom, composing]);

  function selectThread(id: string) {
    setSelectedId(id); setComposing(false); setInternal(false); setIsAtBottom(true); setReadFailed(false); readAttempt.current = ""; setReadRevision(value => value + 1);
  }
  function newThread() { setComposing(true); setSelectedId(null); setInternal(false); }
  function setReply(value: string) { setDrafts(previous => ({ ...previous, [draftKey]: value })); }
  async function loadEarlierMessages() {
    if (!selected || historyInFlight.current) return;
    const threadId = selected.id;
    const cursor = selectedHistory?.nextCursor ?? selected.historyCursor;
    if (!cursor || !hasEarlierMessages) return;
    historyInFlight.current = true;
    setLoadingHistory(threadId);
    setIsAtBottom(false);
    setHistory(previous => ({ ...previous, [threadId]: { messages: previous[threadId]?.messages || selected.messages, hasMore: true, nextCursor: cursor, error: undefined } }));
    try {
      const response = await fetch(`/api/support-history?threadId=${encodeURIComponent(threadId)}&before=${encodeURIComponent(cursor)}`, { cache: "no-store" });
      const result = await response.json() as HistoryPage & { error?: string };
      if (!response.ok) throw new Error(result.error || "Не удалось загрузить предыдущие сообщения.");
      if (!Array.isArray(result.messages) || typeof result.hasMore !== "boolean") throw new Error("Не удалось прочитать историю. Попробуйте ещё раз.");
      const list = listRef.current;
      if (selectedRef.current === threadId && list) scrollAnchor.current = { threadId, top: list.scrollTop, height: list.scrollHeight };
      setHistory(previous => ({ ...previous, [threadId]: { messages: mergeMessages(result.messages, previous[threadId]?.messages || selected.messages), hasMore: result.hasMore, nextCursor: result.nextCursor, error: undefined } }));
    } catch (error) {
      setHistory(previous => ({ ...previous, [threadId]: { ...previous[threadId], error: error instanceof Error ? error.message : "Не удалось загрузить историю." } }));
    } finally { historyInFlight.current = false; setLoadingHistory(null); }
  }
  async function submitNew(event: FormEvent) {
    event.preventDefault();
    if (busy || !subject.trim() || !firstMessage.trim()) return;
    creating.current = new Set([...data.supportThreads.map(thread => thread.id), ...Object.keys(threadCache)]);
    const succeeded = await act({ kind: "createThread", subject: subject.trim(), message: firstMessage.trim(), ...(eventId ? { eventId } : {}) }, "Обращение отправлено. Ответ появится в этой переписке.");
    if (succeeded) { setSubject(""); setFirstMessage(""); setEventId(""); setQuery(""); setDebouncedQuery(""); setFilter("all"); setThreadPage(1); }
    else creating.current = null;
  }
  async function submitReply(event: FormEvent) {
    event.preventDefault();
    if (busy || !selected || !reply.trim()) return;
    const key = draftKey;
    setIsAtBottom(true);
    if (await act({ kind: "replyThread", threadId: selected.id, message: reply.trim(), internal: admin && internal }, internal ? "Заметка добавлена. Видна только команде." : undefined)) {
      setDrafts(previous => ({ ...previous, [key]: "" }));
      replyRef.current?.focus();
    }
  }
  const showDetail = composing || !!selected;

  return <section className={`messages-center ${showDetail ? "mc-show-detail" : ""}`} aria-label={admin ? "Обращения пользователей" : "Переписка с администрацией"}>
    <aside className="mc-inbox">
      <div className="mc-inbox-heading"><div><span className="mc-kicker">{admin ? "СЛУЖБА ПОДДЕРЖКИ" : "МЫ НА СВЯЗИ"}</span><h2>{admin ? "Обращения" : "Мои сообщения"}<span>{totalThreads ?? "…"}</span></h2></div>{!admin && <button className="mc-square" aria-label="Новое обращение" title="Новое обращение" onClick={newThread} disabled={!canCreate}><Plus size={20} /></button>}</div>
      <div className="mc-inbox-summary" title="Статистика обращений на текущей странице"><span><i />На странице: {openCount} открыто</span><span>{unread} новых</span></div>
      <label className="mc-search"><Search size={17} /><input aria-label="Поиск по обращениям" placeholder={admin ? "Имя, тема или сообщение" : "Поиск в сообщениях"} value={query} maxLength={120} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="Очистить поиск сообщений" onClick={() => setQuery("")}><X size={14} /></button>}</label>
      <div className="mc-list-filter"><label htmlFor={`mc-filter-${admin ? "admin" : "user"}`}>Показать</label><div><select id={`mc-filter-${admin ? "admin" : "user"}`} value={filter} onChange={event => { setFilter(event.target.value); setThreadPage(1); }}><option value="all">Все обращения</option><option value="unread">Непрочитанные</option><option value="open">Открытые</option><option value="in_progress">В работе</option><option value="resolved">Решённые</option></select><ChevronDown size={14} /></div></div>
      <div className="mc-thread-list" aria-label="Список обращений" aria-busy={listLoading} ref={inboxRef}>
        {listLoading && <div className="mc-list-loading" role="status"><LoaderCircle className="spin" size={15} />Обновляем обращения…</div>}
        {listError && <div className="mc-list-error" role="alert"><p>{listError}</p><button onClick={() => setListRevision(value => value + 1)}>Повторить загрузку</button></div>}
        {threads.map(thread => { const last = thread.messages.filter(message => admin || !message.internal).at(-1); return <button key={thread.id} className={`mc-thread ${selectedId === thread.id && !composing ? "selected" : ""} ${thread.unreadCount ? "has-unread" : ""}`} onClick={() => selectThread(thread.id)} aria-current={selectedId === thread.id && !composing ? "true" : undefined}>
          <span className="mc-thread-meta"><span>{admin ? thread.userName : "Команда Пар'ИМБА'нк"}</span><time dateTime={thread.updatedAt}>{shortDate(thread.updatedAt)}</time></span>
          <span className="mc-thread-title">{thread.priority === "high" && <Flag size={13} aria-label="Высокий приоритет" />}{thread.subject}{thread.unreadCount > 0 && <b className="mc-unread">{thread.unreadCount}</b>}</span>
          <span className="mc-thread-preview">{last?.internal ? "Заметка: " : last?.isAdmin ? "Команда: " : ""}{last?.body || "Пока нет сообщений"}</span>
          <span className={`mc-status ${thread.status}`}>{thread.status === "resolved" ? <Check size={11} /> : <span />}{labels[thread.status]}</span>
        </button>; })}
        {!listLoading && !listError && !threads.length && <div className="mc-list-empty"><Inbox size={27} /><strong>{query || filter !== "all" ? "Ничего не найдено" : "Обращений пока нет"}</strong><p>{query || filter !== "all" ? "Измените запрос или фильтр." : admin ? "Здесь появятся вопросы пользователей." : "Напишите нам — поможем разобраться."}</p>{(query || filter !== "all") && <button onClick={() => { setQuery(""); setFilter("all"); setThreadPage(1); }}>Сбросить фильтры</button>}</div>}
      </div>
      {(totalThreads || 0) > 20 && <div className="mc-pages"><button disabled={listLoading || threadPage <= 1} onClick={() => setThreadPage(value => value - 1)} aria-label="Предыдущая страница обращений"><ArrowLeft size={15} /></button><span>{threadPage} / {totalPages}<small>{totalThreads} обращений</small></span><button disabled={listLoading || threadPage >= totalPages} onClick={() => setThreadPage(value => value + 1)} aria-label="Следующая страница обращений"><ArrowLeft size={15} style={{ transform: "rotate(180deg)" }} /></button></div>}
      <div className="mc-inbox-footer"><ShieldCheck size={15} /><span>Переписка доступна только вам и команде проекта.</span></div>
    </aside>

    <div className="mc-detail">
      {composing ? <>
        <div className="mc-conversation-heading"><button className="mc-back mc-square" aria-label="К списку сообщений" onClick={() => setComposing(false)}><ArrowLeft size={18} /></button><div><span className="mc-kicker">НОВОЕ ОБРАЩЕНИЕ</span><h3>Расскажите, чем помочь</h3><p>Ответ администрации появится здесь.</p></div><button className="mc-square" aria-label="Закрыть новое обращение" onClick={() => setComposing(false)}><X size={18} /></button></div>
        <form className="mc-new-form" onSubmit={submitNew}>
          <label>Тема обращения<input autoFocus disabled={busy} value={subject} onChange={event => setSubject(event.target.value)} maxLength={100} required placeholder="Например: вопрос о начислении монет" /></label>
          {prizeEvents.length > 0 && <label>Связанный приз<select disabled={busy} value={eventId} onChange={event => setEventId(event.target.value)}><option value="">Общий вопрос</option>{prizeEvents.map(event => <option key={event.id} value={event.id}>{event.title}</option>)}</select></label>}
          <label>Ваше сообщение<textarea disabled={busy} rows={7} value={firstMessage} onChange={event => setFirstMessage(event.target.value)} maxLength={2000} required placeholder="Опишите вопрос подробнее. Если произошла ошибка, расскажите, что вы делали перед её появлением." /></label>
          <div className="mc-character-count">{firstMessage.length} / 2 000</div>
          <div className="mc-response-note"><Clock3 size={18} /><span>Ориентир ответа — до {data.settings.supportResponseHours} ч. Переписка сохранится в разделе «Сообщения».</span></div>
          {!canCreate && <p className="mc-notice">Приём новых обращений временно приостановлен. В существующих переписках можно отвечать.</p>}
          <button className="primary" type="submit" disabled={busy || !subject.trim() || !firstMessage.trim() || !canCreate}>{busy ? <LoaderCircle size={17} className="spin" /> : <Send size={17} />}Отправить обращение</button>
        </form>
      </> : selected ? <>
        <div className="mc-conversation-heading"><button className="mc-back mc-square" aria-label="К списку сообщений" onClick={() => setSelectedId(null)}><ArrowLeft size={18} /></button><div><span className="mc-kicker">{admin ? selected.userName : "КОМАНДА ПАР'ИМБА'НК"} · № {selected.id.slice(-6).toUpperCase()}</span><h3>{selected.subject}</h3>{selected.eventTitle && <p>По розыгрышу «{selected.eventTitle}»</p>}</div><span className={`mc-status ${selected.status}`}>{labels[selected.status]}</span></div>
        <div className="mc-thread-tools">
          {admin ? <><label>Статус<select aria-label="Статус обращения" value={selected.status} disabled={busy} onChange={event => act({ kind: "updateThread", threadId: selected.id, status: event.target.value })}><option value="open">Открыто</option><option value="in_progress">В работе</option><option value="resolved">Решено</option></select></label><label><Flag size={13} />Приоритет<select aria-label="Приоритет обращения" value={selected.priority} disabled={busy} onChange={event => act({ kind: "updateThread", threadId: selected.id, priority: event.target.value })}><option value="normal">Обычный</option><option value="high">Высокий</option></select></label></> : <><span><Clock3 size={13} />{fullDate(selected.createdAt)}</span><button disabled={busy} onClick={() => act({ kind: "updateThread", threadId: selected.id, status: selected.status === "resolved" ? "open" : "resolved" }, selected.status === "resolved" ? "Обращение открыто повторно" : "Обращение отмечено решённым")}><CheckCheck size={15} />{selected.status === "resolved" ? "Открыть снова" : "Вопрос решён"}</button></>}
        </div>
        {readFailed && selected.unreadCount > 0 && <div className="mc-read-retry"><span>Не удалось обновить отметку о прочтении.</span><button disabled={busy} onClick={() => { readAttempt.current = ""; setReadRevision(value => value + 1); }}>Повторить</button></div>}
        {threadError && <div className="mc-read-retry" role="alert"><span>{threadError}</span><button onClick={() => setListRevision(value => value + 1)}>Обновить</button></div>}
        <div className="mc-history" ref={listRef} onScroll={() => { const element = listRef.current; if (element) setIsAtBottom(element.scrollHeight - element.scrollTop - element.clientHeight < 70); }} role="log" aria-label="История переписки" aria-live="polite" aria-relevant="additions">
          {hasEarlierMessages ? <div className="mc-history-pagination"><button disabled={!!loadingHistory} onClick={loadEarlierMessages}>{loadingHistory === selected.id ? <LoaderCircle size={14} className="spin" /> : <Clock3 size={14} />}{loadingHistory === selected.id ? "Загружаем историю…" : "Загрузить предыдущие сообщения"}</button>{selectedHistory?.error && <p role="alert">{selectedHistory.error}</p>}</div> : <div className="mc-history-start"><ShieldCheck size={14} />Начало переписки · {shortDate(selected.createdAt)}</div>}
          {messages.map(message => { const mine = message.senderId === data.user.id; return <article key={message.id} className={`mc-message ${mine ? "mine" : "other"} ${message.internal ? "internal" : ""}`}>
            <div className="mc-message-author">{message.internal ? <LockKeyhole size={12} /> : message.isAdmin ? <ShieldCheck size={12} /> : null}<strong>{mine ? "Вы" : message.isAdmin ? `${message.senderName} · команда Пар'ИМБА'нк` : message.senderName}</strong>{message.internal && <span>Только команде</span>}</div>
            <p>{message.body}</p><time dateTime={message.createdAt}>{fullDate(message.createdAt)}</time>
          </article>; })}
          {selected.status === "resolved" && <div className="mc-resolved"><CheckCheck size={15} />Обращение решено. Новый ответ откроет его повторно.</div>}
        </div>
        {!isAtBottom && <button className="mc-newest" onClick={() => setIsAtBottom(true)}><ChevronDown size={15} />К последним сообщениям</button>}
        <form className={`mc-reply ${internal ? "is-internal" : ""}`} onSubmit={submitReply}>
          {admin && <div className="mc-compose-tabs" role="group" aria-label="Тип сообщения"><button type="button" className={!internal ? "active" : ""} aria-pressed={!internal} onClick={() => setInternal(false)}><MessageCircle size={14} />Ответ пользователю</button><button type="button" className={internal ? "active" : ""} aria-pressed={internal} onClick={() => setInternal(true)}><LockKeyhole size={13} />Заметка команде</button></div>}
          <label className="mc-reply-label" htmlFor={`mc-reply-${admin ? "admin" : "user"}`}>{internal ? "Внутренняя заметка" : "Ваш ответ"}</label>
          <textarea ref={replyRef} disabled={busy} id={`mc-reply-${admin ? "admin" : "user"}`} rows={3} value={reply} onChange={event => setReply(event.target.value)} maxLength={2000} required placeholder={internal ? "Эту заметку увидят только сотрудники…" : "Напишите сообщение…"} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && reply.trim() && !busy) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
          <div className="mc-reply-bottom"><span>{internal ? <><LockKeyhole size={12} />Не отправляется пользователю</> : <><Check size={12} />{reply.length} / 2 000 · Ctrl + Enter</>}</span><button className="primary" type="submit" disabled={busy || !reply.trim()}>{busy ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{internal ? "Добавить заметку" : "Отправить"}</button></div>
        </form>
      </> : <div className="mc-welcome"><div className="mc-welcome-art"><MessageCircle size={40} /><span><Check size={18} /></span></div><span className="mc-kicker">ХОРОШИЙ ДИАЛОГ НАЧИНАЕТСЯ ЗДЕСЬ</span><h3>{admin ? "Каждое обращение — на виду" : "Давайте разберёмся вместе"}</h3><p>{admin ? "Выберите обращение, чтобы ответить участнику, оставить заметку команде или изменить статус." : "Вопросы о билетах, монетах или призах? Напишите администрации и следите за ответами в одной переписке."}</p>{!admin && <button className="primary" disabled={!canCreate} onClick={newThread}><Plus size={17} />Новое обращение</button>}{!admin && !canCreate && <p className="mc-notice">Приём новых обращений временно приостановлен.</p>}<div className="mc-welcome-foot"><Clock3 size={15} />Ориентир ответа: до {data.settings.supportResponseHours} ч.</div></div>}
    </div>
  </section>;
}
