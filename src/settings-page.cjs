/**
 * 原生设置窗口里的「Auralis」页签：顶部为头像入口实时预览，其下分组管理本地资料、外观、背景、
 * 导航、使用分析、页面透明与官方功能。所有修改立即生效并防抖保存到服务端（全部浏览器共享）。
 * 核心：createSettingsPage(React, { store, components, resolveIdentity }) → { SettingsPage, describeHostResult }。
 */
'use strict';

const { LIMITS } = require('./settings-model.cjs');

const AVATAR_SIZE = 128;

const styles = `
.auralis-settings{display:grid;gap:18px;padding:4px 2px 24px;color:var(--dsw-alias-label-primary);font-size:13px}
.auralis-settings *{box-sizing:border-box}
.auralis-settings-hero{position:relative;overflow:hidden;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:center;padding:18px;border:1px solid var(--dsw-alias-border-l1);border-radius:14px;background:radial-gradient(120% 140% at 0% 0%,color-mix(in srgb,var(--dsw-alias-brand-primary) 16%,transparent),transparent 60%),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 55%,transparent)}
.auralis-settings-hero::after{content:'';position:absolute;inset:auto -40px -60px auto;width:180px;height:180px;border-radius:50%;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent);pointer-events:none}
.auralis-settings-eyebrow{font:10px ui-monospace,monospace;letter-spacing:.14em;color:var(--dsw-alias-label-secondary)}
.auralis-settings-hero h2{margin:6px 0 4px;font-size:18px;font-weight:650}
.auralis-settings-hero p{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
.auralis-settings-preview{display:flex;align-items:center;gap:10px;z-index:1}
.auralis-settings-preview-wide{width:220px;padding:4px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent)}
.auralis-settings-preview-rail{width:48px;padding:4px;border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-bg-base) 60%,transparent)}
.auralis-settings-preview .auralis-profile-trigger{pointer-events:none}
.auralis-settings-source{display:inline-flex;align-items:center;gap:6px;margin-top:10px;padding:3px 9px;border-radius:999px;font-size:11px;background:var(--dsw-alias-button-ghost-active-fill);color:var(--dsw-alias-brand-primary)}
.auralis-settings-group{padding:4px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-settings-card-fill,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 45%,transparent))}
.auralis-settings-group > h3{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin:12px 0 2px;font-size:12px;font-weight:650;letter-spacing:.06em;color:var(--dsw-alias-label-secondary)}
.auralis-settings-group > h3 small{font-weight:400;letter-spacing:0}
.auralis-settings-row{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 0;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.auralis-settings-row:last-child{border-bottom:0}
.auralis-settings-row-copy{min-width:0}
.auralis-settings-row-title{font-size:13px;line-height:20px}
.auralis-settings-row-desc{margin-top:2px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary)}
.auralis-settings-note{margin-top:4px;font-size:11px;line-height:17px;color:var(--dsw-alias-brand-primary)}
.auralis-settings-note[data-tone=warn]{color:#d97706}.auralis-settings-note[data-tone=bad]{color:#dc2626}
.auralis-settings-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0;border-radius:11px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .16s}
.auralis-settings-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:transform .16s}
.auralis-settings-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)}
.auralis-settings-switch[aria-checked=true]::after{transform:translateX(16px)}
.auralis-settings-switch:disabled{opacity:.5;cursor:default}
.auralis-settings-range{display:flex;align-items:center;gap:10px;flex:none}
.auralis-settings-range input{width:150px;accent-color:var(--dsw-alias-brand-primary)}
.auralis-settings-range output{min-width:38px;text-align:right;font:11px ui-monospace,monospace;color:var(--dsw-alias-label-secondary)}
.auralis-settings-input{width:220px;max-width:100%;padding:7px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-specific-input-major);color:inherit;font:inherit;font-size:13px}
.auralis-settings-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:8px;flex:none}
.auralis-settings-btn{padding:6px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);color:inherit;font:inherit;font-size:12px;cursor:pointer}
.auralis-settings-btn:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.auralis-settings-btn:disabled{opacity:.5;cursor:default}
.auralis-settings-btn[data-tone=danger]{color:#dc2626}
.auralis-settings :is(button,input):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.auralis-settings-thumb{flex:none;width:120px;height:68px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background-size:cover;background-position:center}
.auralis-settings-avatar-choice{display:flex;align-items:center;gap:8px}
.auralis-settings-avatar-choice .auralis-profile-avatar{width:34px;height:34px}
.auralis-settings-status{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.auralis-settings-error{padding:8px 12px;border:1px solid #ef444466;border-radius:8px;background:#ef44441a;font-size:12px;line-height:1.6}
.auralis-settings-file{position:absolute;width:1px;height:1px;opacity:0;pointer-events:none}
@media(max-width:640px){.auralis-settings-hero{grid-template-columns:minmax(0,1fr)}.auralis-settings-row{flex-wrap:wrap}.auralis-settings-range input{width:120px}}
@media(prefers-reduced-motion:reduce){.auralis-settings-switch,.auralis-settings-switch::after{transition:none}}
`;

/** 把官方开关结果翻译成提示；application 取值见 pluginManager ChangeResult，另加 reload-required。 */
function describeHostResult(result) {
  if (!result) return undefined;
  switch (result.application) {
    case 'applied': return { tone: 'ok', text: '已保存并应用；若界面未变化请刷新页面。' };
    case 'reload-required': return { tone: 'warn', text: '已保存，刷新页面后生效。' };
    case 'restart-required': return { tone: 'warn', text: '已保存，需重启 DSH 后生效。' };
    case 'overridden': return { tone: 'warn', text: '已保存，但被更高层配置（home 或命令行）覆盖，当前不生效。' };
    case 'cancelled': return { tone: 'warn', text: '操作已取消。' };
    default: return { tone: 'bad', text: `修改失败：${result.error?.diagnostic ?? result.error?.code ?? '未知错误'}` };
  }
}

/** 浏览器端把头像图片裁成正方形并缩放到 128px，输出 WebP data URL；超出上限时报错。 */
async function shrinkAvatar(file) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = AVATAR_SIZE;
  canvas.getContext('2d').drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  bitmap.close();
  const url = canvas.toDataURL('image/webp', 0.9);
  if (url.length > LIMITS.avatarChars) throw new Error('头像压缩后仍过大');
  return url;
}

function createSettingsPage(React, { store, components, resolveIdentity }) {
  const h = React.createElement;
  const { ProfileLauncher, Avatar } = components;

  function Switch({ checked, onChange, label, disabled }) {
    return h('button', {
      type: 'button', role: 'switch', className: 'auralis-settings-switch', 'aria-checked': Boolean(checked), 'aria-label': label,
      disabled, onClick: () => onChange(!checked),
    });
  }
  function Row({ title, desc, note, children }) {
    return h('div', { className: 'auralis-settings-row' },
      h('div', { className: 'auralis-settings-row-copy' },
        h('div', { className: 'auralis-settings-row-title' }, title),
        desc ? h('div', { className: 'auralis-settings-row-desc' }, desc) : null,
        note ? h('div', { className: 'auralis-settings-note', 'data-tone': note.tone, role: 'status' }, note.text) : null),
      children);
  }
  function Group({ title, hint, children }) {
    return h('section', { className: 'auralis-settings-group', 'aria-label': title }, h('h3', null, title, hint ? h('small', null, hint) : null), children);
  }
  function Range({ label, value, min, max, unit, onChange }) {
    return h('div', { className: 'auralis-settings-range' },
      h('input', { type: 'range', min, max, value, 'aria-label': label, onChange: event => onChange(Number(event.target.value)) }),
      h('output', null, `${value}${unit}`));
  }
  function FileButton({ label, accept, onFile, disabled }) {
    const input = React.useRef(null);
    return h(React.Fragment, null,
      h('input', {
        ref: input, type: 'file', accept, className: 'auralis-settings-file', tabIndex: -1, 'aria-hidden': true,
        onChange: event => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) onFile(file);
        },
      }),
      h('button', { type: 'button', className: 'auralis-settings-btn', disabled, onClick: () => input.current?.click() }, label));
  }

  function SettingsPage() {
    const snapshot = React.useSyncExternalStore(store.subscribe, store.getSnapshot);
    const [avatarError, setAvatarError] = React.useState('');
    React.useEffect(() => {
      store.loadHost();
      return () => {
        store.flush();
      };
    }, []);
    const { settings, account, host, hostNotes, hostBusy } = snapshot;
    const { appearance, nav, usage, pages, profile } = settings;
    const identity = resolveIdentity(settings, account);
    const update = (group, values) => store.update({ [group]: values });
    const toggle = (group, key, title, desc) => h(Row, { title, desc },
      h(Switch, { label: title, checked: settings[group][key], onChange: value => update(group, { [key]: value }) }));
    const accountText = {
      'signed-in': '已登录：头像入口显示账号资料',
      'signed-out': '未登录：头像入口显示本地资料',
      loading: '正在读取登录状态…',
      error: '登录状态读取失败，显示本地资料',
      unavailable: '宿主未提供账号服务，显示本地资料',
    }[account.status] ?? '';
    const hostRow = (key, title, desc) => {
      const item = host?.[key];
      const note = describeHostResult(hostNotes[key]) ?? (item && !item.available ? { tone: 'warn', text: `当前不可修改（${item.reason}）` } : undefined);
      return h(Row, { title, desc, note },
        h(Switch, { label: title, checked: item?.enabled, disabled: !item?.available || Boolean(hostBusy), onChange: value => store.setHost(key, value) }));
    };

    return h('div', { className: 'auralis-settings' },
      h('style', null, styles),
      h('header', { className: 'auralis-settings-hero' },
        h('div', null,
          h('div', { className: 'auralis-settings-eyebrow' }, 'AURALIS'),
          h('h2', null, '主题与使用分析'),
          h('p', null, '修改即时生效，保存在服务端，所有浏览器共享。'),
          h('span', { className: 'auralis-settings-source', 'data-source': identity.source }, accountText)),
        h('div', { className: 'auralis-settings-preview', 'aria-label': '头像入口预览' },
          h('div', { className: 'auralis-settings-preview-wide' }, h(ProfileLauncher, { wide: true, settingsOpen: false, openSettings() {}, identity })),
          h('div', { className: 'auralis-settings-preview-rail' }, h(ProfileLauncher, { wide: false, settingsOpen: false, openSettings() {}, identity })))),
      snapshot.error ? h('div', { className: 'auralis-settings-error', role: 'alert' }, snapshot.error) : null,

      h(Group, { title: '本地资料', hint: '未登录时显示' },
        h(Row, { title: '昵称', desc: `最多 ${LIMITS.nameChars} 字；留空恢复 Kared。` },
          h('input', { className: 'auralis-settings-input', value: profile.name, maxLength: LIMITS.nameChars, 'aria-label': '昵称', onChange: event => update('profile', { name: event.target.value }) })),
        h(Row, { title: '签名', desc: `最多 ${LIMITS.subtitleChars} 字，可留空。` },
          h('input', { className: 'auralis-settings-input', value: profile.subtitle, maxLength: LIMITS.subtitleChars, 'aria-label': '签名', onChange: event => update('profile', { subtitle: event.target.value }) })),
        h(Row, { title: '头像', desc: '内置像素小人，或上传图片（自动裁成正方形并压缩）。', note: avatarError ? { tone: 'bad', text: avatarError } : undefined },
          h('div', { className: 'auralis-settings-avatar-choice' },
            h('span', { className: 'auralis-profile-avatar' }, h(Avatar, { avatar: profile.avatar === 'pixel' ? { kind: 'pixel' } : { kind: 'image', src: profile.avatar } })),
            h(FileButton, {
              label: '上传', accept: 'image/png,image/jpeg,image/webp',
              onFile: file => shrinkAvatar(file).then(avatar => {
                setAvatarError('');
                update('profile', { avatar });
              }, error => setAvatarError(`头像处理失败：${error.message}`)),
            }),
            h('button', { type: 'button', className: 'auralis-settings-btn', disabled: profile.avatar === 'pixel', onClick: () => update('profile', { avatar: 'pixel' }) }, '像素小人'))),
        toggle('profile', 'preferAccount', '登录时显示账号资料', '关闭后始终显示本地资料。')),

      h(Group, { title: '外观' },
        toggle('appearance', 'enabled', '启用 Auralis 主题', '关闭后恢复官方配色、背景与分区。'),
        toggle('appearance', 'glass', '毛玻璃', '分区背景模糊；关闭可减轻 GPU 负担。'),
        h(Row, { title: '浅色遮罩', desc: '数值越大背景越淡。' },
          h(Range, { label: '浅色遮罩', value: appearance.veil, min: 0, max: 90, unit: '%', onChange: veil => update('appearance', { veil }) })),
        h(Row, { title: '深色遮罩' },
          h(Range, { label: '深色遮罩', value: appearance.veilDark, min: 0, max: 90, unit: '%', onChange: veilDark => update('appearance', { veilDark }) })),
        h(Row, { title: '分区缝隙' },
          h(Range, { label: '分区缝隙', value: appearance.gap, min: 0, max: 16, unit: 'px', onChange: gap => update('appearance', { gap }) })),
        h(Row, { title: '外边距' },
          h(Range, { label: '外边距', value: appearance.edge, min: 0, max: 16, unit: 'px', onChange: edge => update('appearance', { edge }) }))),

      h(Group, { title: '背景', hint: `PNG / JPEG / WebP，≤ ${LIMITS.backgroundBytes / 1024 / 1024} MB` },
        h(Row, { title: settings.background.custom ? '自定义背景' : '内置背景', desc: '上传后替换当前背景，所有浏览器同步。' },
          h('div', { className: 'auralis-settings-actions' },
            h('span', { className: 'auralis-settings-thumb', 'data-custom': settings.background.custom, style: snapshot.backgroundUrl ? { backgroundImage: `url("${snapshot.backgroundUrl}")` } : undefined }),
            h(FileButton, { label: '更换', accept: 'image/png,image/jpeg,image/webp', disabled: snapshot.saving, onFile: file => store.uploadBackground(file) }),
            h('button', { type: 'button', className: 'auralis-settings-btn', disabled: !settings.background.custom, onClick: () => store.clearBackground() }, '恢复默认')))),

      h(Group, { title: '导航' },
        toggle('nav', 'launcher', '头像入口', '关闭后左下角恢复官方入口。'),
        toggle('nav', 'pluginCenter', '「插件」改名为「插件中心」')),

      h(Group, { title: '使用分析' },
        h(Row, { title: '启用使用分析', desc: '同时控制侧栏入口与主面板。' },
          h(Switch, { label: '启用使用分析', checked: usage.enabled, onChange: enabled => update('usage', { enabled }) }))),

      h(Group, { title: '页面透明', hint: '需启用 Auralis 主题' },
        toggle('pages', 'automation', '自动化任务页透明'),
        toggle('pages', 'settingsGlass', '设置窗口毛玻璃')),

      h(Group, { title: '官方功能', hint: '写入 profile 配置；卸载 Auralis 后保留' },
        snapshot.hostError ? h('div', { className: 'auralis-settings-note', 'data-tone': 'bad', role: 'alert' }, snapshot.hostError) : null,
        hostRow('account', '官方账号界面', '左下角账号菜单与设置里的账号页；开启后头像入口仍由 Auralis 显示。'),
        hostRow('feedback', '消息反馈按钮', '回复下方的赞 / 踩反馈。'),
        hostRow('onboarding', '模型首次引导', '未配置模型时的引导弹窗。'),
        h(Row, { title: '恢复官方功能默认', desc: '三项全部关闭，并清理用户层的对应条目。' },
          h('button', { type: 'button', className: 'auralis-settings-btn', disabled: Boolean(hostBusy) || !host, onClick: () => store.resetHost() }, hostBusy === 'reset' ? '恢复中…' : '恢复'))),

      h('footer', { className: 'auralis-settings-status' },
        h('span', null, snapshot.saving ? '保存中…' : snapshot.ready ? '已同步到服务端' : '读取中…'),
        h('button', { type: 'button', className: 'auralis-settings-btn', 'data-tone': 'danger', onClick: () => store.reset() }, '恢复插件默认')));
  }
  return { SettingsPage, describeHostResult };
}

module.exports = { createSettingsPage, describeHostResult };
