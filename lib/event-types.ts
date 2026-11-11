export type UserRole = 'owner' | 'admin' | 'moderator' | 'user';
export type EventStatus = 'active' | 'completed' | 'scheduled' | 'paused' | 'cancelled';
export type AppEvent = {
  id:string; title:string; subtitle:string; region:string; city:string; category:string; imageKey:string;
  totalTickets:number; soldTickets:number; ticketPrice:number; status:EventStatus; startsAt:string;
  winnerTicket:number|null; winnerName:string|null; winnerUserId:string|null; drawnAt:string|null;
  myTickets:number[]; archived:boolean; prizeType:string; prizeName:string; imageId:string|null; imageUrl:string|null;
};
export type CoinRequest = { id:string; userId:string; userName:string; amount:number; message:string; status:'pending'|'approved'|'rejected'; createdAt:string };
export type ProjectSettings = { participationEnabled:boolean; coinRequestsEnabled:boolean; supportEnabled:boolean; announcement:string; supportResponseHours:number };
export type SupportMessage = { id:string; senderId:string; senderName:string; isAdmin:boolean; internal:boolean; body:string; createdAt:string };
export type SupportThread = {
  id:string; userId:string; userName:string; subject:string; eventId:string|null; eventTitle:string|null;
  status:'open'|'in_progress'|'resolved'; priority:'normal'|'high'; unreadCount:number; createdAt:string; updatedAt:string; messages:SupportMessage[]; hasEarlierMessages:boolean; historyCursor:string|null;
};
export type AdminUser = {id:string;name:string;balance:number;role:UserRole;status:'active'|'blocked';createdAt:string;ticketCount:number;eventCount:number};
export type AppState = {
  user:{id:string;name:string;balance:number;isAdmin:boolean;isOwner:boolean;role:UserRole;status:'active'|'blocked'};
  events:AppEvent[]; categories:string[]; requests:CoinRequest[];
  notifications:{id:string;title:string;message:string;read:boolean;createdAt:string}[];
  transactions:{id:string;label:string;amount:number;createdAt:string}[];
  adminUsers:AdminUser[];
  contactMessages:{id:string;userId:string;userName:string;eventId:string|null;eventTitle:string|null;message:string;createdAt:string}[];
  supportThreads:SupportThread[]; settings:ProjectSettings;
  adminTransactions:{id:string;userId:string;userName:string;label:string;amount:number;createdAt:string}[];
  auditLog:{id:string;actorId:string;actorName:string;action:string;targetId:string;details:string;createdAt:string}[];
  adminParticipants:{eventId:string;userId:string;userName:string;ticketNumbers:number[]}[];
  adminStats:{users:number;activeEvents:number;totalTickets:number;pendingRequests:number;openThreads:number;coinsInCirculation:number}|null;
  limits:{users:number;threads:number;messagesPerThread:number;transactions:number;audit:number;participants:number};
};
export type EventFields = {title:string;subtitle:string;region:string;city:string;category:string;imageKey?:string;prizeType:string;prizeName:string;imageId?:string|null;totalTickets:number;ticketPrice:number;startsAt:string};
export type EventAction =
  | {kind:'buy';eventId:string;quantity:number;requestId:string}
  | {kind:'requestCoins';amount:number;message:string}
  | {kind:'reviewRequest';id:string;approved:boolean}
  | {kind:'createCategory';name:string}
  | ({kind:'createEvent'} & EventFields)
  | ({kind:'updateEvent';eventId:string} & EventFields)
  | {kind:'setEventStatus';eventId:string;status:'active'|'paused'|'cancelled';reason:string}
  | {kind:'readNotifications'}
  | {kind:'contact';eventId?:string;message:string}
  | {kind:'createThread';subject:string;message:string;eventId?:string}
  | {kind:'replyThread';threadId:string;message:string;internal?:boolean}
  | {kind:'readThread';threadId:string;readThrough?:string}
  | {kind:'updateThread';threadId:string;status?:'open'|'in_progress'|'resolved';priority?:'normal'|'high'}
  | {kind:'updateUser';userId:string;role?:'admin'|'moderator'|'user';status?:'active'|'blocked';reason:string}
  | {kind:'adjustBalance';userId:string;amount:number;reason:string;requestId:string}
  | {kind:'updateSettings';settings:ProjectSettings};
