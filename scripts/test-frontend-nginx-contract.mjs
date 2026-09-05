import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(
	new URL('../nginx/frontend.conf', import.meta.url),
	'utf8'
)
const staticStore = '/opt/winwidget/deploy/frontend/assets'
const staticBody = namespace =>
	`alias ${staticStore}/${namespace}/_next/static/; autoindex off; disable_symlinks on; expires 1y;`
const normalizeBody = body => body.replace(/\s+/g, ' ').trim()

const widgetsRoutes = [
	'cabinet',
	'payment',
	'login',
	'register',
	'restore-password',
	'social-auth',
	'logout',
	'wheels',
	'quizzes',
	'callbacks',
	'timers',
	'stop-offers',
	'calculators',
	'page-wheel',
	'page-quiz',
	'page-callback',
	'page-timer',
	'page-stop-offer',
	'page-ai-consultant',
	'page-calculator'
]

const blocks = (text, pattern) => {
	const result = []
	for (const match of text.matchAll(pattern)) {
		const opening = text.indexOf('{', match.index)
		let depth = 1
		let ending = opening + 1
		while (ending < text.length && depth) {
			if (text[ending] === '{') depth += 1
			if (text[ending] === '}') depth -= 1
			ending += 1
		}
		assert.equal(depth, 0, 'balanced Nginx blocks')
		result.push({
			name: match[1]?.trim(),
			body: text.slice(opening + 1, ending - 1)
		})
	}
	return result
}

const locationTarget = (locations, input) => {
	const pathname = new URL(input, 'https://winwidget.ru').pathname
	const exact = locations.find(
		location =>
			location.name.startsWith('= ') && pathname === location.name.slice(2)
	)
	if (exact) return normalizeBody(exact.body)
	const prefixes = locations.filter(
		location =>
			!location.name.startsWith('= ') &&
			!location.name.startsWith('~ ') &&
			pathname.startsWith(location.name.replace(/^\^~ /, ''))
	)
	prefixes.sort(
		(left, right) =>
			right.name.replace(/^\^~ /, '').length -
			left.name.replace(/^\^~ /, '').length
	)
	if (prefixes[0]?.name.startsWith('^~ '))
		return normalizeBody(prefixes[0].body)
	const regex = locations.find(
		location =>
			location.name.startsWith('~ ') &&
			new RegExp(location.name.slice(2)).test(pathname)
	)
	const selected = regex ?? prefixes[0]
	return selected && normalizeBody(selected.body)
}

const verify = config => {
	const text = config.replace(/^\s*#.*$/gm, '')
	assert.doesNotMatch(
		text,
		/\b(?:include|rewrite|root|proxy_cache|resolver|set|try_files|error_page)\b/,
		'no hidden routing or shared runtime include'
	)
	assert.deepEqual(
		[...text.matchAll(/\balias\s+([^;]+);/g)]
			.map(match => match[1])
			.sort(),
		['legacy', 'landing', 'widgets', 'admin-panel', 'crm']
			.map(namespace => `${staticStore}/${namespace}/_next/static/`)
			.sort(),
		'exact five static stores only; no traversal, variable or sibling aliases'
	)
	assert.doesNotMatch(
		text,
		/api\.winwidget\.ru|:4100|:4200|:4700|winwidget\.ru_server/,
		'frontend proxy never reaches backend runtimes'
	)
	const upstreams = blocks(text, /\bupstream\s+(\w+)\s*\{/g)
	assert.deepEqual(upstreams.map(upstream => upstream.name).sort(), [
		'winwidget_admin',
		'winwidget_crm',
		'winwidget_landing',
		'winwidget_widgets'
	])
	const ports = {
		winwidget_landing: 3000,
		winwidget_crm: 3001,
		winwidget_widgets: 3002,
		winwidget_admin: 3003
	}
	for (const upstream of upstreams) {
		assert.equal(
			upstream.body.replace(/\s+/g, ' ').trim(),
			`server 127.0.0.1:${ports[upstream.name]}; keepalive 32;`
		)
	}
	const maps = blocks(text, /\bmap\s+([^{}]+)\{/g)
	assert.equal(maps.length, 1)
	assert.equal(maps[0].name, '$http_upgrade $connection_upgrade')
	assert.equal(
		maps[0].body.replace(/\s+/g, ' ').trim(),
		"default upgrade; '' close;"
	)
	const servers = blocks(text, /\bserver\s*\{/g)
	assert.equal(servers.length, 4)
	for (const host of [
		'winwidget.ru www.winwidget.ru',
		'crm.winwidget.ru'
	]) {
		const owned = servers.filter(server =>
			server.body.includes(`server_name ${host};`)
		)
		assert.equal(owned.length, 2)
		const plain = owned.find(server => /listen 80;/.test(server.body))
		const tls = owned.find(server =>
			/listen 443 ssl http2;/.test(server.body)
		)
		assert.ok(plain && tls)
		assert.equal(
			plain.body.replace(/\s+/g, ' ').trim(),
			`listen 80; listen [::]:80; server_name ${host}; return 301 https://$host$request_uri;`
		)
		assert.ok(tls.body.includes('listen [::]:443 ssl http2;'))
		const certificateHost = host.startsWith('crm.')
			? 'crm.winwidget.ru'
			: 'winwidget.ru'
		assert.ok(
			tls.body.includes(
				`ssl_certificate /etc/letsencrypt/live/${certificateHost}/fullchain.pem;`
			)
		)
		assert.ok(
			tls.body.includes(
				`ssl_certificate_key /etc/letsencrypt/live/${certificateHost}/privkey.pem;`
			)
		)
		for (const directive of [
			'ssl_protocols TLSv1.2 TLSv1.3;',
			'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
			'add_header X-Content-Type-Options "nosniff" always;',
			'add_header Referrer-Policy "strict-origin-when-cross-origin" always;',
			'proxy_http_version 1.1;',
			'proxy_set_header Host $host;',
			'proxy_set_header X-Real-IP $remote_addr;',
			'proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
			'proxy_set_header X-Forwarded-Proto $scheme;',
			'proxy_set_header Upgrade $http_upgrade;',
			'proxy_set_header Connection $connection_upgrade;',
			'proxy_read_timeout 60s;',
			'proxy_send_timeout 60s;'
		])
			assert.equal(tls.body.split(directive).length - 1, 1, directive)
		assert.doesNotMatch(
			tls.body,
			/Content-Security-Policy/,
			'Next retains its existing per-route CSP'
		)
		const locations = blocks(tls.body, /\blocation\s+([^{}]+)\{/g)
		if (certificateHost === 'crm.winwidget.ru') {
			assert.ok(
				tls.body.includes('add_header X-Frame-Options "DENY" always;')
			)
			assert.deepEqual(
				locations.map(location => [
					location.name,
					normalizeBody(location.body)
				]),
				[
					['^~ /_next/static/', staticBody('crm')],
					['/', 'proxy_pass http://winwidget_crm;']
				]
			)
			for (const pathname of [
				'/',
				'/billing',
				'/invitations/example',
				'/_next/image?url=%2Ficon.png&w=64&q=75'
			])
				assert.equal(
					locationTarget(locations, pathname),
					'proxy_pass http://winwidget_crm;'
				)
			for (const asset of [
				'chunks/app.js',
				'media/font.woff2',
				'missing.js'
			])
				assert.equal(
					locationTarget(locations, `/_next/static/${asset}?v=opaque`),
					staticBody('crm')
				)
			continue
		}
		assert.ok(
			tls.body.includes('add_header X-Frame-Options "SAMEORIGIN" always;')
		)
		const expected = [
			['^~ /_next/static/', staticBody('legacy')],
			...['landing', 'widgets', 'admin-panel'].map(app => [
				`^~ /_frontends/${app}/_next/static/`,
				staticBody(app)
			]),
			[
				'^~ /_frontends/landing/_next/',
				'proxy_pass http://winwidget_landing;'
			],
			[
				'^~ /_frontends/widgets/_next/',
				'proxy_pass http://winwidget_widgets;'
			],
			[
				'^~ /_frontends/admin-panel/_next/',
				'proxy_pass http://winwidget_admin;'
			],
			['^~ /_frontends/', 'return 404;'],
			['= /admin', 'proxy_pass http://winwidget_admin;'],
			['^~ /admin/', 'proxy_pass http://winwidget_admin;'],
			[
				`~ ^/(${widgetsRoutes.join('|')})(/|$)`,
				'proxy_pass http://winwidget_widgets;'
			],
			['/', 'proxy_pass http://winwidget_landing;']
		]
		assert.deepEqual(
			locations.map(location => [
				location.name,
				normalizeBody(location.body)
			]),
			expected,
			'exact location ownership; proxy_pass must preserve URI and query'
		)
		for (const route of widgetsRoutes) {
			for (const suffix of ['', '/', '/example', '?returnUrl=opaque'])
				assert.equal(
					locationTarget(locations, `/${route}${suffix}`),
					'proxy_pass http://winwidget_widgets;'
				)
			assert.equal(
				locationTarget(locations, `/${route}-unrelated`),
				'proxy_pass http://winwidget_landing;'
			)
		}
		for (const route of [
			'/admin',
			'/admin/',
			'/admin/crm?workspaceId=opaque'
		])
			assert.equal(
				locationTarget(locations, route),
				'proxy_pass http://winwidget_admin;'
			)
		for (const route of [
			'/',
			'/legal-documentation/oferta',
			'/robots.txt',
			'/sitemap.xml',
			'/icon.png',
			'/images/tools/wheel-widget-preview.png',
			'/administrator'
		])
			assert.equal(
				locationTarget(locations, route),
				'proxy_pass http://winwidget_landing;'
			)
		for (const [app, upstream] of [
			['landing', 'landing'],
			['widgets', 'widgets'],
			['admin-panel', 'admin']
		]) {
			for (const asset of [
				'chunks/example.js',
				'media/font.woff2',
				'missing.js'
			])
				assert.equal(
					locationTarget(
						locations,
						`/_frontends/${app}/_next/static/${asset}`
					),
					staticBody(app)
				)
			assert.equal(
				locationTarget(
					locations,
					`/_frontends/${app}/_next/image?url=%2Ficon.png&w=64&q=75`
				),
				`proxy_pass http://winwidget_${upstream};`
			)
		}
		for (const asset of ['chunks/old.js', 'media/old.woff2', 'missing.js'])
			assert.equal(
				locationTarget(locations, `/_next/static/${asset}`),
				staticBody('legacy')
			)
		assert.equal(
			locationTarget(locations, '/_next/image?url=%2Ficon.png&w=64&q=75'),
			'proxy_pass http://winwidget_landing;'
		)
		for (const route of [
			'/_frontends/unknown/_next/static/app.js',
			'/_frontends/crm/_next/image',
			'/_frontends/widgets/health',
			'/_frontends/widgets/_next-malformed'
		])
			assert.equal(locationTarget(locations, route), 'return 404;')
	}
}

verify(source)
const mutations = [
	[
		'public upstream',
		source.replace('server 127.0.0.1:3002;', 'server 0.0.0.0:3002;')
	],
	[
		'backend fallback',
		source.replace(
			'proxy_pass http://winwidget_widgets;',
			'proxy_pass http://api.winwidget.ru;'
		)
	],
	[
		'URI stripped',
		source.replace(
			'proxy_pass http://winwidget_widgets;',
			'proxy_pass http://winwidget_widgets/;'
		)
	],
	[
		'asset routed to sibling',
		source.replace(
			'location ^~ /_frontends/widgets/_next/',
			'location ^~ /_frontends/wrong/_next/'
		)
	],
	['widget boundary removed', source.replace(')(/|$)', ')')],
	[
		'admin widened',
		source.replace('location ^~ /admin/', 'location ^~ /admin')
	],
	[
		'unknown assets accepted',
		source.replace('return 404;', 'proxy_pass http://winwidget_landing;')
	],
	[
		'CRM uses wrong certificate',
		source.replace(
			'live/crm.winwidget.ru/fullchain.pem',
			'live/winwidget.ru/fullchain.pem'
		)
	],
	[
		'iframe contract weakened',
		source.replace('"SAMEORIGIN"', '"ALLOWALL"')
	],
	['hidden include', source + '\ninclude /etc/nginx/unreviewed.conf;\n'],
	['hidden root', source + '\nroot /etc;\n'],
	['hidden resolver', source + '\nresolver 127.0.0.1;\n'],
	[
		'extra static alias',
		source + `\nalias ${staticStore}/crm/_next/static/;\n`
	],
	[
		'cross-namespace store',
		source.replace(`${staticStore}/widgets/`, `${staticStore}/crm/`)
	],
	[
		'store path traversal',
		source.replace(
			`${staticStore}/widgets/`,
			`${staticStore}/widgets/../crm/`
		)
	],
	[
		'location path traversal',
		source.replace(
			'/_frontends/widgets/_next/static/',
			'/_frontends/widgets/_next/static/../'
		)
	],
	[
		'missing alias slash',
		source.replace(
			'/assets/legacy/_next/static/;',
			'/assets/legacy/_next/static;'
		)
	],
	[
		'symlink traversal enabled',
		source.replace('disable_symlinks on;', 'disable_symlinks off;')
	],
	[
		'directory listing enabled',
		source.replace('autoindex off;', 'autoindex on;')
	],
	[
		'static regex precedence changed',
		source.replace('location ^~ /_next/static/', 'location /_next/static/')
	],
	[
		'location security headers shadowed',
		source.replace('expires 1y;', 'expires 1y; add_header X-Static true;')
	],
	[
		'static proxy fallback',
		source.replace(
			'expires 1y;',
			'expires 1y; proxy_pass http://winwidget_landing;'
		)
	],
	[
		'missing static error fallback',
		source.replace('expires 1y;', 'expires 1y; error_page 404 = /;')
	],
	['static cache contract removed', source.replace('expires 1y;', '')]
]
for (const [name, mutated] of mutations)
	assert.throws(() => verify(mutated), undefined, name)
console.log(
	`Four frontend Nginx contracts passed: host/path/immutable static ownership, loopback upstreams, TLS/iframe headers, exact URI forwarding and ${mutations.length} rejected routing mutations.`
)
