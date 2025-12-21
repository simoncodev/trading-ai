// Socket.IO connection
const socket = io();

// Filter decisions by type
function filterDecisions(decision) {
    const cards = document.querySelectorAll('.decision-card-large');
    const buttons = document.querySelectorAll('.tab-btn');
    
    buttons.forEach(btn => btn.classList.remove('active'));
    event.target.classList.add('active');
    
    cards.forEach(card => {
        if (decision === 'all') {
            card.style.display = '';
        } else {
            card.style.display = card.dataset.decision === decision ? '' : 'none';
        }
    });
}

// Make function global
window.filterDecisions = filterDecisions;

// Listen for new decisions
socket.on('decision:new', (decision) => {
    console.log('New decision received:', decision);
    // Could add to grid dynamically
});

console.log('Decisions page initialized');
