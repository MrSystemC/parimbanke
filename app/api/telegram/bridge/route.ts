import { performTelegramBridge } from '@/lib/telegram-service';
import { errorResponse } from '@/lib/event-service';
export const dynamic='force-dynamic';
export async function POST(request:Request){try{return Response.json(await performTelegramBridge(request),{headers:{'Cache-Control':'no-store'}});}catch(error){return errorResponse(error);}}
