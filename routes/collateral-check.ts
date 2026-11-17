import {createServer} from '../server/context.js';
export function route(env){const srv=createServer(env);return {async POST(req){try{await srv.identity(req);return srv.response({error:'Separate collateral verification is disabled. Use the strict trade-page menu to verify the collateral and completed transfer together.'},410);}catch(e){return srv.response({error:e.message},e.status||400);}}};}
