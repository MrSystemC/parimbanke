import { performAction, errorResponse } from '@/lib/event-service';
export const dynamic = 'force-dynamic';
export async function POST(request:Request) {
  try { return Response.json(await performAction(request),{headers:{'Cache-Control':'no-store'}}); }
  catch(error) { return errorResponse(error); }
}
