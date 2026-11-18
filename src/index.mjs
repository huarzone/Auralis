/** Auralis 服务端入口：仅组合使用分析与设置路由，鉴权沿用 DSH Connection。 */
import { registerSettingsRoutes } from './settings-server.mjs';
import { registerUsageRoute } from './usage-server.mjs';

export const name = 'auralis';
export const inject = ['connection', 'sessionQuery', 'profileContext'];

export function apply(ctx) {
  registerUsageRoute(ctx);
  registerSettingsRoutes(ctx);
}
