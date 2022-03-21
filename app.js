const DEFAULT_CORS_PROXY = 'https://cors.zserge.com/?u=';
const MAX_ENTRIES_PER_FEED = 500;
const MAX_ENTRIES_ON_PAGE = 1000;
const STORAGE_STATE_KEY = 'state-v1';

const DEFAULT_FEED_URLS = [
	'https://news.ycombinator.com/rss',
	'https://lobste.rs/rss',
	'https://drewdevault.com/blog/index.xml',
	'https://emersion.fr/blog/atom.xml',
	'https://sourcehut.org/blog/index.xml',
];

function parseFeed(text) {
	const feed = new DOMParser().parseFromString(text, 'text/xml')
		.documentElement;
	switch (feed.nodeName) {
		case 'rss':
			return Array.from(feed.querySelectorAll('item'))
				.map(item => ({
					url: tagContent(item, 'link'),
					title: tagContent(item, 'title'),
					date: new Date(tagContent(item, 'pubDate')),
					comments: tagContent(item, 'comments'),
				}));
		case 'feed':
			return Array.from(feed.querySelectorAll('entry'))
				.map(entry => ({
					url: entry.querySelector('link').getAttribute('href'),
					title: tagContent(entry, 'title'),
					date: new Date(tagContent(entry, 'published')),
				}));
	}
	return [];
}

function tagContent(el, name) {
	return el.querySelector(name)?.textContent;
}

function restore(urls) {
	let state = localStorage.getItem(STORAGE_STATE_KEY)
	if (!state) {
		return { feeds: urls.map(url => ({ url, entries: [] })) };
	}

	state = JSON.parse(state);
	return {
		date: new Date(state.date),
		feeds: state.feeds.map(feed => ({
			...feed,
			entries: feed.entries.map(entry => ({
				...entry,
				date: new Date(entry.date),
			})),
		})),
	};
}

async function render(urls) {
	const state = restore(urls);
	const main = document.querySelector('main');
	const articleTempl = document.querySelector('#article');
	const commentsTempl = document.querySelector('#comments');

	const entries = state.feeds
		.flatMap(feed =>
			feed.entries.map(entry => ({
				...entry,
				feed: new URL(feed.url).host,
			})))
		.sort((a, b) => b.date - a.date)
		.slice(0, MAX_ENTRIES_ON_PAGE);

	for (let entry of entries) {
		const articleClone = articleTempl.content.cloneNode(true);
		const url = articleClone.querySelector('a');
		url.setAttribute('href', entry.url);
		url.textContent = entry.title;
		const feed = articleClone.querySelector('small');
		feed.textContent = entry.feed;

		if (entry.comments) {
			const commentsClone = commentsTempl.content.cloneNode(true);
			const commentsUrl = commentsClone.querySelector('a');
			commentsUrl.setAttribute('href', entry.comments);
			commentsUrl.textContent = 'Comments';
			const article = articleClone.querySelector('article');
			article.appendChild(commentsClone);
		}

		main.appendChild(articleClone);
	}
}

(async (urls) => {
	// Register service worker for PWA
	navigator.serviceWorker.register('sw.js');

	// Render cached news
	render(urls);

	let state = restore(urls);
	if (state.date && (new Date() - state.date) / 60000 < 15) {
		return;
	}

	// Fetch each feed and render news
	state.date = new Date();
	for (let feed of state.feeds) {
		try {
			const response = await fetch(DEFAULT_CORS_PROXY + encodeURIComponent(feed.url), {
				headers: {
					'Content-Security-Policy': "connect-src 'self' " + DEFAULT_CORS_PROXY
				}
			});
			const text = await response.text();
			const entries = parseFeed(text);

			const filtered = entries.filter(entry =>
				feed.entries.findIndex(other => entry.url === other.url) < 0);

			feed.entries = feed.entries
				.concat(filtered)
				.sort((a, b) => b.date - a.date)
				.slice(0, MAX_ENTRIES_PER_FEED);
		} catch (err) {
			console.error(err)
		}
	}
	localStorage.setItem(STORAGE_STATE_KEY, JSON.stringify(state));
	render(urls);
})(DEFAULT_FEED_URLS);
