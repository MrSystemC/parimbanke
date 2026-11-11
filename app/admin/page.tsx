import Home from '../page';
import { requireChatGPTUser } from '../chatgpt-auth';
import { getState } from '@/lib/event-service';
import { ArrowRight, ShieldCheck } from 'lucide-react';
export const dynamic='force-dynamic';
export const metadata={title:"Админ-панель — Пар'ИМБА'нк"};
export default async function AdminPage({searchParams}:{searchParams?:Promise<Record<string,string|string[]|undefined>>}={}){
  const params=await searchParams;
  const tab=typeof params?.tab==='string'&&['overview','events','requests','users','messages','ledger','settings','audit','guide'].includes(params.tab)?params.tab:null;
  const returnTo=tab?`/admin?tab=${encodeURIComponent(tab)}`:'/admin';
  if(!import.meta.env.DEV)await requireChatGPTUser(returnTo);
  const state=await getState();
  if(!state.user.isAdmin)return <main className="admin-access-shell"><div className="admin-access-card"><ShieldCheck size={42}/><div className="eyebrow">ПАР'ИМБА'НК / CONTROL ROOM</div><h1>Вход для команды</h1><p>Вы вошли как <strong>{state.user.name}</strong>. Для доступа используйте аккаунт владельца проекта или аккаунт с назначенной ролью администратора или модератора.</p><a className="primary" href={`/signout-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`} target="_top">Сменить аккаунт<ArrowRight size={18}/></a><a className="text-link" href="/">Вернуться к розыгрышам</a><small>Владелец назначает роли в разделе «Пользователи». Доступ проверяется на сервере.</small></div></main>;
  return <Home initialPage="admin" initialData={state}/>;
}
