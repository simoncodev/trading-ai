// Socket.IO connection
const socket = io();

// Filter trades by status
function filterTrades(status) {
    const rows = document.querySelectorAll('.trade-row');
    const buttons = document.querySelectorAll('.tab-btn');
    
    buttons.forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    
    rows.forEach(row => {
        if (status === 'all') {
            row.style.display = '';
        } else {
            row.style.display = row.dataset.status === status ? '' : 'none';
        }
    });
}

// Make function global
window.filterTrades = filterTrades;

// Listen for new trades
socket.on('trade:new', (trade) => {
    console.log('New trade received:', trade);
    // Could add to table dynamically
    location.reload(); // Simple refresh for now
});

console.log('Trades page initialized');
