const bcrypt = require('bcryptjs');
const db = require('./db/database');

const username = 'admin';
const password = 'password123'; // Change this to something stronger for real use!

bcrypt.hash(password, 10).then(hashedPassword => {
  db.run(
    'INSERT INTO users (username, password, role) VALUES (?, ?, ?)',
    [username, hashedPassword, 'admin'],
    function (err) {
      if (err) {
        console.error('Error creating admin user:', err.message);
      } else {
        console.log('Admin user created! Username: admin, Password: password123');
      }
      process.exit();
    }
  );
});
