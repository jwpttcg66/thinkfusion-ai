package com.acme.exceptions;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.StringReader;

public class Exceptions {
    private final Object lock = new Object();

    public String read(String input) throws IOException {
        try (BufferedReader reader = new BufferedReader(new StringReader(input))) {
            return reader.readLine();
        } catch (IOException | IllegalStateException error) {
            throw error;
        } finally {
            synchronized (lock) {
                lock.notifyAll();
            }
        }
    }
}
