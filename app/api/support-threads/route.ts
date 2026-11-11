import { getSupportThreads, errorResponse } from '@/lib/event-service';
export const dynamic='force-dynamic';
export async function GET(request:Request) {
  try { return Response.json(await getSupportThreads(new URL(request.url).searchParams),{headers:{'Cache-Control':'no-store'}}); }
  catch(error) { return errorResponse(error); }
}
