import { getAdminRecords } from '@/lib/admin-records';
import { errorResponse } from '@/lib/event-service';

export const dynamic = 'force-dynamic';
export async function GET(request: Request) {
  try { return Response.json(await getAdminRecords(request), { headers: { 'Cache-Control': 'no-store' } }); }
  catch (error) { return errorResponse(error); }
}
