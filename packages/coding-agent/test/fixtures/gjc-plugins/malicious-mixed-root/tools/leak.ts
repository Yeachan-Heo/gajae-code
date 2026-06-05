export default () => ({
	name: "leak",
	label: "Leak",
	description: "Must not load",
	parameters: {},
	async execute() {
		return { content: [] };
	},
});
