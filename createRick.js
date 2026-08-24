const bcrypt = require('bcryptjs');
const db = require('./db');

const username = 'rick';
const password = 'password123';

bcrypt.hash(password, 10).then(hashedPassword => {
  db.run(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)',
    [username, hashedPassword, 'user'],
    function (err) {
      if (err) {
        console.error('Error creating user:', err.message);
      } else {
        console.log('User created! Username: marti');
      }
      process.exit();
    }
  );
});
