"use client";

import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { ThumbsUp, MessageCircle, Share2, Plus, Play, MoreHorizontal } from 'lucide-react';
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import ChatSidebar from '@/components/ChatSidebar';

const HomePage = () => {
  // Placeholder for stories (Facebook style but unique)
  const stories = [
    { id: '1', user: 'Alice', avatar: 'https://github.com/shadcn.png', image: 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=300&h=500&fit=crop' },
    { id: '2', user: 'Bob', avatar: 'https://github.com/shadcn.png', image: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=300&h=500&fit=crop' },
    { id: '3', user: 'Charlie', avatar: 'https://github.com/shadcn.png', image: 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=300&h=500&fit=crop' },
    { id: '4', user: 'Diana', avatar: 'https://github.com/shadcn.png', image: 'https://images.unsplash.com/photo-1539571696357-5a69c17a67c6?w=300&h=500&fit=crop' },
    { id: '5', user: 'Eve', avatar: 'https://github.com/shadcn.png', image: 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=300&h=500&fit=crop' },
  ];

  // Placeholder for Moments (Short Videos)
  const moments = [
    { id: 'm1', title: 'Sunset vibes 🌅', views: '1.2k', image: 'https://images.unsplash.com/photo-1495615080073-6b89c98beddb?w=300&h=500&fit=crop' },
    { id: 'm2', title: 'Coding life 💻', views: '5k', image: 'https://images.unsplash.com/photo-1587620962725-abab7fe55159?w=300&h=500&fit=crop' },
    { id: 'm3', title: 'Coffee time ☕', views: '800', image: 'https://images.unsplash.com/photo-1461988320302-985875c20024?w=300&h=500&fit=crop' },
    { id: 'm4', title: 'Travel goal ✈️', views: '10k', image: 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=300&h=500&fit=crop' },
  ];

  // Placeholder for posts
  const posts = [
    {
      id: 'p1',
      user: 'Equyvo Official',
      avatar: 'https://github.com/shadcn.png',
      time: '2 hours ago',
      content: 'Welcome to Equyvo! We are excited to build this community with you. Share your first thought!',
      image: null,
      likes: 120,
      comments: 15,
      shares: 5,
    },
    {
      id: 'p2',
      user: 'Jane Doe',
      avatar: 'https://github.com/shadcn.png',
      time: '5 hours ago',
      content: 'Just posted a new moment! Check it out on my profile.',
      image: 'https://images.unsplash.com/photo-1611162617474-5b21e879e113?w=800&fit=crop',
      likes: 85,
      comments: 8,
      shares: 2,
    },
  ];

  return (
    <div className="flex gap-6 relative">
      {/* Main Content Feed */}
      <div className="flex-1 space-y-8 max-w-2xl mx-auto w-full">

        {/* Story Panel (Facebook Style but Unique) */}
        <div className="relative">
          <ScrollArea className="w-full whitespace-nowrap rounded-xl">
            <div className="flex space-x-4 p-1">
              {/* Add Story Button */}
              <div className="relative w-32 h-52 flex-shrink-0 cursor-pointer group">
                <div className="absolute inset-0 bg-secondary rounded-xl overflow-hidden transition-transform duration-300 group-hover:scale-[1.02]">
                  <div className="h-2/3 bg-primary/20 flex items-center justify-center">
                    <Avatar className="w-16 h-16 border-4 border-background">
                      <AvatarImage src="https://github.com/shadcn.png" />
                      <AvatarFallback>ME</AvatarFallback>
                    </Avatar>
                  </div>
                  <div className="h-1/3 bg-secondary flex flex-col items-center justify-start pt-6 relative">
                    <div className="absolute -top-4 w-8 h-8 bg-primary rounded-full flex items-center justify-center border-4 border-secondary text-white shadow-lg">
                      <Plus className="w-5 h-5" />
                    </div>
                    <span className="font-semibold text-sm">Create Story</span>
                  </div>
                </div>
              </div>

              {/* Stories */}
              {stories.map((story) => (
                <div key={story.id} className="relative w-32 h-52 flex-shrink-0 cursor-pointer group">
                  <div className="absolute inset-0 rounded-xl overflow-hidden transition-transform duration-300 group-hover:scale-[1.02] shadow-sm hover:shadow-lg">
                    <img src={story.image} alt={story.user} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent" />
                    <div className="absolute top-2 left-2 w-10 h-10 rounded-full border-2 border-primary p-0.5 z-10">
                      <Avatar className="w-full h-full border-2 border-black">
                        <AvatarImage src={story.avatar} />
                        <AvatarFallback>{story.user[0]}</AvatarFallback>
                      </Avatar>
                    </div>
                    <span className="absolute bottom-3 left-3 text-white font-bold text-sm tracking-wide z-10">{story.user}</span>
                  </div>
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" className="hidden" />
          </ScrollArea>
        </div>

        {/* Moments Section (Short Videos) */}
        <div className="space-y-4">
          <div className="flex items-center justify-between px-2">
            <h2 className="text-xl font-bold flex items-center gap-2">
              <Play className="w-5 h-5 fill-primary text-primary" /> Moments
            </h2>
            <Button variant="link" className="text-primary">View All</Button>
          </div>
          <ScrollArea className="w-full whitespace-nowrap rounded-xl">
            <div className="flex space-x-4 p-1">
              {moments.map((moment) => (
                <div key={moment.id} className="relative w-40 h-64 flex-shrink-0 cursor-pointer group rounded-xl overflow-hidden">
                  <img src={moment.image} alt={moment.title} className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110" />
                  <div className="absolute inset-x-0 bottom-0 p-3 bg-gradient-to-t from-black/80 to-transparent">
                    <p className="text-white font-bold text-sm truncate">{moment.title}</p>
                    <p className="text-white/80 text-xs">{moment.views} views</p>
                  </div>
                  <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-black/20">
                    <div className="w-10 h-10 bg-white/20 backdrop-blur-md rounded-full flex items-center justify-center">
                      <Play className="w-5 h-5 text-white fill-white ml-0.5" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <ScrollBar orientation="horizontal" className="hidden" />
          </ScrollArea>
        </div>

        {/* Post Feed */}
        <div className="space-y-6">
          {posts.map((post) => (
            <Card key={post.id} className="border-border/50 shadow-sm hover:shadow-md transition-shadow duration-300">
              <CardHeader className="flex flex-row items-center gap-3 p-4">
                <Avatar className="h-10 w-10 ring-2 ring-border/50">
                  <AvatarImage src={post.avatar} />
                  <AvatarFallback>{post.user.substring(0, 2)}</AvatarFallback>
                </Avatar>
                <div className="flex-1">
                  <CardTitle className="text-base font-bold hover:text-primary cursor-pointer transition-colors">{post.user}</CardTitle>
                  <p className="text-xs text-muted-foreground">{post.time} • 🌎</p>
                </div>
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <p className="px-4 pb-4 text-sm leading-relaxed">{post.content}</p>
                {post.image && (
                  <div className="w-full max-h-[500px] overflow-hidden bg-muted">
                    <img src={post.image} alt="Post content" className="w-full h-full object-cover hover:scale-[1.01] transition-transform duration-500" />
                  </div>
                )}
                <div className="p-3 grid grid-cols-3 gap-2">
                  <Button variant="ghost" size="sm" className="flex items-center justify-center gap-2 text-muted-foreground hover:bg-primary/10 hover:text-primary transition-colors group">
                    <ThumbsUp className="h-4 w-4 group-hover:scale-110 transition-transform" /> <span className="font-medium">{post.likes}</span>
                  </Button>
                  <Button variant="ghost" size="sm" className="flex items-center justify-center gap-2 text-muted-foreground hover:bg-blue-500/10 hover:text-blue-500 transition-colors group">
                    <MessageCircle className="h-4 w-4 group-hover:scale-110 transition-transform" /> <span className="font-medium">{post.comments}</span>
                  </Button>
                  <Button variant="ghost" size="sm" className="flex items-center justify-center gap-2 text-muted-foreground hover:bg-green-500/10 hover:text-green-500 transition-colors group">
                    <Share2 className="h-4 w-4 group-hover:scale-110 transition-transform" /> <span className="font-medium">{post.shares}</span>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Chat Sidebar (Desktop Only) */}
      <div className="hidden xl:block w-80 relative">
        <ChatSidebar />
      </div>
    </div>
  );
};

export default HomePage;