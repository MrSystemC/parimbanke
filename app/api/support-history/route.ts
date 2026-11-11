import { getSupportHistory, errorResponse, AppError } from '@/lib/event-service';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try {
    const params=new URL(request.url).searchParams;
    const threadId=params.get('threadId');
    if(!threadId || threadId.length>100) throw new AppError('Укажите обращение.');
    return Response.json(await getSupportHistory(threadId,params.get('before')),{headers:{'Cache-Control':'no-store'}});
  } catch(error) { return errorResponse(error); }
}
