export const BROWSER_TARGETS = [
  { id: "chrome", label: "CHROME", app: "/Applications/Google Chrome.app", image: "chrome" },
  { id: "safari", label: "SAFARI", app: "/Applications/Safari.app", image: "safari" },
];

export const SSH_TARGETS = [
  { id: "vq-batch", label: "VQ BATCH\n3990X", host: "bellmanhs.iptime.org", user: "bellman", port: 22, cwd: "/home/bellman/Workspace/VibeQuant", image: "ssh-vq-batch" },
  { id: "gajae", label: "GAJAE\n3970X", host: "bellmanhs.iptime.org", user: "bellman", port: 24, cwd: "/mnt/offloading/Workspace/gaebal-gajae-blog", image: "ssh-gajae" },
  { id: "vq-lab", label: "VQ LAB\nEPYC 9654", host: "bellmanhs.iptime.org", user: "bellman", port: 25, cwd: "/home/bellman/Workspace/VibeQuant", image: "ssh-vq-lab" },
];

export const USAGE_TARGETS = [
  { id: "usage", label: "USAGE", match: "api.layofflabs.com/management", url: "https://api.layofflabs.com/management.html#/usage", image: "usage-v2" },
  { id: "keeper", label: "KEEPER", match: "api.layofflabs.com/keeper", url: "https://api.layofflabs.com/keeper/", image: "usage-keeper" },
];
