package com.acme.login;

import java.util.Optional;

public class UserRepository {
    private final Database database;

    public UserRepository(Database database) {
        this.database = database;
    }

    public User findByEmail(String email) {
        return database.queryOne(
            "select id, email, password_hash from users where email = ?",
            email
        );
    }
}
