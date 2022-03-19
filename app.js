const DEFAULT_CORS_PROXY = 'https://cors.zserge.com/?u=';
const MAX_ENTRIES_PER_FEED = 500;
const MAX_ENTRIES_ON_PAGE = 1000;
const STATE = 'state';

const URLS = [
	'https://drewdevault.com/blog/index.xml',
	'https://news.ycombinator.com/rss',
	'https://lobste.rs/rss',
	'https://emersion.fr/blog/atom.xml',
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
	let state = localStorage.getItem(STATE)
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
	const main = document.querySelector("main");
	const template = document.querySelector("#article");

	const entries = state.feeds
		.flatMap(feed =>
			feed.entries.map(entry => ({
				...entry,
				feed: new URL(feed.url).host,
			})))
		.sort((a, b) => b.date - a.date)
		.slice(0, MAX_ENTRIES_ON_PAGE);

	for (let entry of entries) {
		const clone = template.content.cloneNode(true);
		const urls = clone.querySelectorAll("a");
		urls[0].setAttribute("href", entry.url);
		urls[0].textContent = entry.title;
		if (entry.comments) {
			urls[1].setAttribute("href", entry.comments);
			urls[1].textContent = "Comments";
		} else {
			urls[1].remove();
		}
		const feed = clone.querySelector("small");
		feed.textContent = entry.feed;

		main.appendChild(clone);
	}
}

(async (urls) => {
	// Register service worker for PWA
	navigator.serviceWorker.register('sw.js');

	// Render cached news
	render(urls);

	// Fetch each feed and render news
	let state = restore(urls);
	state.date = new Date();
	for (let feed of state.feeds) {
		const response = await fetch(DEFAULT_CORS_PROXY + feed.url);
		const text = await response.text();
		const entries = parseFeed(text);

		const filtered = entries.filter(entry =>
			feed.entries.findIndex(other =>
				(entry.url === other.url || entry.title === other.title)) < 0);

		feed.entries = feed.entries
			.concat(filtered)
			.sort((a, b) => b.date - a.date)
			.slice(0, MAX_ENTRIES_PER_FEED);
	}
	localStorage.setItem(STATE, JSON.stringify(state));
	render(urls);
})(URLS);
