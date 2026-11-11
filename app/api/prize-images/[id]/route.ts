import { readPrizeImage } from '@/lib/prize-images';
import { errorResponse } from '@/lib/event-service';
export const dynamic='force-dynamic';
export async function GET(_request:Request,{params}:{params:Promise<{id:string}>}) {
  try{return await readPrizeImage((await params).id);}
  catch(error){return errorResponse(error);}
}
