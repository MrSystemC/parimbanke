import { getTelegramLinkState, performTelegramLinkAction } from '@/lib/telegram-service';
import { errorResponse } from '@/lib/event-service';
export const dynamic='force-dynamic';
export async function GET(){try{return Response.json(await getTelegramLinkState(),{headers:{'Cache-Control':'no-store'}});}catch(error){return errorResponse(error);}}
export async function POST(request:Request){try{return Response.json(await performTelegramLinkAction(request),{headers:{'Cache-Control':'no-store'}});}catch(error){return errorResponse(error);}}
