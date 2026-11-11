import { uploadPrizeImage } from '@/lib/prize-images';
import { errorResponse } from '@/lib/event-service';
export const dynamic='force-dynamic';
export async function POST(request:Request) {
  try{return Response.json(await uploadPrizeImage(request),{status:201,headers:{'Cache-Control':'no-store'}});}
  catch(error){return errorResponse(error);}
}
