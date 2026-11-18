package com.example.AIoTLibTQB.repository;

import com.example.AIoTLibTQB.document.RoomFurnitureLayout;
import org.springframework.data.mongodb.repository.MongoRepository;

import java.util.Optional;

public interface RoomFurnitureLayoutRepository extends MongoRepository<RoomFurnitureLayout, String> {

    Optional<RoomFurnitureLayout> findByRoomId(String roomId);
}
