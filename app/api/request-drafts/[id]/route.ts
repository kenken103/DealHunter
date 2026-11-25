import { requestDraftApi } from "../../../lib/request-draft-api";

type Context = { params: Promise<{ id: string }> };
async function handle(request: Request, context: Context) {
  return requestDraftApi(request, (await context.params).id);
}

export { handle as GET, handle as PUT, handle as DELETE };
