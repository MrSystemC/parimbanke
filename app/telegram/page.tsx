import { requireChatGPTUser } from '../chatgpt-auth';
import { TelegramLinkPanel } from '@/components/telegram-link-panel';

export const dynamic = 'force-dynamic';
export const metadata = { title: "Telegram-кабинет — Пар'ИМБА'нк" };

export default async function TelegramPage() {
  await requireChatGPTUser('/telegram');
  return <TelegramLinkPanel/>;
}
