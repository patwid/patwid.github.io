const DEFAULT_CORS_PROXY = 'https://cors.zserge.com/?u=';
const STATE = 'state';

const URLS = [
	'https://drewdevault.com/blog/index.xml',
	'https://news.ycombinator.com/rss',
	'https://lobste.rs/rss',
	'https://emersion.fr/blog/atom.xml',
];

function parseFeed(text) {
	const feed = new DOMParser().parseFromString(text, 'text/xml').documentElement;
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

function restore() {
	let state = localStorage.getItem(STATE)
	if (!state) {
		return null;
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

function save(state) {
	localStorage.setItem(STATE, JSON.stringify(state));
}

async function load(urls) {
	let state = restore();
	if (!state || (new Date() - state.date) / 60000 > 15) {
		state = {
			date: new Date(),
			feeds: [],
		};
		for (let url of urls) {
			const response = await fetch(DEFAULT_CORS_PROXY + url);
			const text = await response.text();
			const entries = parseFeed(text);
			state.feeds.push({ url, entries });
		}
		save(state);
	}
	return state;
}

async function render(urls) {
	const state = await load(urls);
	const main = document.querySelector("main");
	const template = document.querySelector("#article");

	const entries = state.feeds
		.flatMap(feed =>
			feed.entries.map(entry => ({
				...entry,
				feed: new URL(feed.url).host,
			})))
		.sort((a, b) => b.date - a.date);

	for (let entry of entries) {
		const clone = template.content.cloneNode(true);
		const url = clone.querySelector("a");
		url.setAttribute("href", entry.comments || entry.url);
		url.textContent = entry.title;
		const feed = clone.querySelector("small");
		feed.textContent = entry.feed;

		main.appendChild(clone);
	}
}

render(URLS);
